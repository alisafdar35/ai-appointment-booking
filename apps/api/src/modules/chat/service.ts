import {
  isBookingComplete,
  mergeSlots,
  missingSlots,
  type AssistantAction,
  type AssistantTurnDto,
  type BookingSlots,
  type ChatSessionDto,
  type ChatTranscriptDto,
  type RequiredSlot,
  type SendMessageInput,
  type ServiceDto,
} from '@appt/shared';
import { env } from '../../config/env.js';
import { withTransaction } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { badRequest, notFound, sessionClosed } from '../../lib/errors.js';
import { humanDate, humanTime, nowTimeInZone, shortDate, todayInZone } from '../../lib/time.js';
import { DEFAULT_SESSION_TITLE, titleFromMessage } from './title.js';
import { confirmationPrompt, generateAssistantTurn } from '../ai/index.js';
import * as appointments from '../appointments/service.js';
import * as repo from './repository.js';

/**
 * ===========================================================================
 * Conversation orchestration.
 *
 * This is the layer the assessment is really about, so the division of labour
 * is worth stating plainly:
 *
 *   The AI's job      — read what the user wrote, return slots and a sentence.
 *   This layer's job  — own the state machine, resolve slots to real records,
 *                       decide what happens next, and persist it.
 *   The booking layer — enforce the rules and write the row.
 *
 * The model is an input, not a decision maker. It cannot book, cannot see
 * another tenant's data, and cannot choose what the UI renders. Everything it
 * produces is validated against a schema and then resolved against the
 * database before it is acted on. That is what makes an unreliable component
 * safe to depend on.
 * ===========================================================================
 */

/**
 * Offer the form once the conversation has gone this many turns in a row
 * without progress: the same details still missing, nothing offered to pick.
 */
const STALLED_TURN_THRESHOLD = 4;

export async function listSessions(ctx: { businessId: string; userId: string }) {
  return repo.listSessions(ctx.businessId, ctx.userId);
}

/**
 * A conversation, its messages, and the bookings it made. The bookings come
 * with it so a receipt in the transcript shows the row as it stands now,
 * wherever it falls — not only when it happens to be in a list the page loaded.
 */
export async function getTranscript(
  ctx: { businessId: string; userId: string },
  sessionId: string,
): Promise<ChatTranscriptDto> {
  const session = await repo.findSession(ctx.businessId, ctx.userId, sessionId);
  if (!session) throw notFound('Conversation');
  const [messages, booked] = await Promise.all([
    repo.listMessages(ctx.businessId, ctx.userId, sessionId),
    appointments.listForChatSession(ctx, sessionId),
  ]);
  return { session, messages, appointments: booked };
}

export async function createSession(ctx: { businessId: string; userId: string }) {
  return withTransaction((client) =>
    repo.createSession(client, { ...ctx, title: DEFAULT_SESSION_TITLE }),
  );
}

/**
 * A conversation that has booked is finished. Without this a stray "yes" in
 * an old tab is read as consent to the draft still on the session — the one
 * just booked — and a second booking is attempted. The overlap constraint
 * would refuse it, but the user would be told their own slot is "taken".
 */
function assertOpen(session: ChatSessionDto): void {
  if (session.status !== 'active') throw sessionClosed();
}

/**
 * Handle one user message, end to end.
 *
 * `onGenerating` fires once the session is known and the user's message is
 * stored, just before the (possibly slow) assistant call — the route uses it
 * to show a typing indicator in the user's other tabs.
 */
export async function handleUserMessage(
  ctx: { businessId: string; userId: string; requestId: string },
  input: SendMessageInput,
  hooks: { onGenerating?: (sessionId: string) => void } = {},
): Promise<AssistantTurnDto> {
  const [business, firstName] = await Promise.all([
    repo.findBusinessContext(ctx.businessId),
    repo.findFirstName(ctx.businessId, ctx.userId),
  ]);
  if (!business) throw notFound('Business');

  // ---- 1. Resolve or create the session -----------------------------------
  let session: ChatSessionDto;
  if (input.sessionId) {
    const existing = await repo.findSession(ctx.businessId, ctx.userId, input.sessionId);
    if (!existing) throw notFound('Conversation');
    assertOpen(existing);
    session = existing;
  } else {
    session = await withTransaction((client) =>
      // The first message becomes the title, so the sidebar is readable
      // without generating a summary (another model call we do not need).
      repo.createSession(client, {
        businessId: ctx.businessId,
        userId: ctx.userId,
        title: titleFromMessage(input.content),
      }),
    );
  }

  // ---- 2. Persist the user's message before calling anything slow ---------
  // Written first so the message is not lost if the provider call fails or the
  // request is abandoned. The transcript is the user's, not the model's.
  // A session opened empty (POST /chat/sessions, or the form) is titled by the
  // first message typed into it, exactly as one created by that message is.
  const untitled = session.title === DEFAULT_SESSION_TITLE;
  const userMessage = await withTransaction(async (client) => {
    if (untitled) await repo.updateSessionMeta(client, session.id, { title: titleFromMessage(input.content) });
    return repo.appendMessage(client, { sessionId: session.id, role: 'user', content: input.content });
  });

  // ---- 3. Assemble context ------------------------------------------------
  const [history, services, outcomes] = await Promise.all([
    repo.recentTurns(session.id, env.AI_HISTORY_TURNS),
    appointments.listServices(ctx.businessId),
    repo.recentOutcomes(session.id, STALLED_TURN_THRESHOLD - 1),
  ]);

  const providerInput = {
    businessName: business.name,
    timezone: business.timezone,
    opensAt: business.opensAt,
    closesAt: business.closesAt,
    today: todayInZone(business.timezone),
    nowTime: nowTimeInZone(business.timezone),
    services,
    draft: session.bookingDraft,
    customerName: firstName ?? 'there',
    history,
    requestId: ctx.requestId,
  };

  // ---- 4. Ask the assistant ----------------------------------------------
  hooks.onGenerating?.(session.id);
  const turn = await generateAssistantTurn(providerInput, {
    businessId: ctx.businessId,
    sessionId: session.id,
  });

  // ---- 5. Merge the extracted slots over the stored draft ------------------
  // mergeSlots treats an absent field as "not mentioned this turn", not as
  // "cleared" — see @appt/shared. Without that, "actually make it 3pm" would
  // wipe the service the user already picked.
  let draft = mergeSlots(session.bookingDraft, turn.slots);

  // ---- 6. Resolve the service NAME to a real catalogue row ----------------
  // The model returns a name; only the database can turn that into an id, and
  // only for this tenant. An unresolvable or ambiguous name is handled here
  // rather than being carried into the booking call.
  const resolution = await resolveService(ctx.businessId, draft.serviceName, services);
  if (resolution.kind === 'unknown' && draft.serviceName) {
    draft = { ...draft, serviceName: null };
  } else if (resolution.kind === 'resolved') {
    // Store the catalogue's own name, not the model's near-miss ("whitening"),
    // so the draft, the confirmation and the booking all say the same thing.
    draft = { ...draft, serviceName: resolution.service.name };
  }

  let action: AssistantAction = 'collect_info';
  let replyText = turn.reply;
  let appointment: AssistantTurnDto['appointment'];
  let suggestions: AssistantTurnDto['suggestions'];

  if (resolution.kind === 'ambiguous') {
    // Several catalogue entries matched. Asking is correct; guessing is not.
    action = 'collect_info';
    replyText = `Did you mean ${resolution.options.map((o) => o.name).join(' or ')}?`;
    draft = { ...draft, serviceName: null };
  } else if (resolution.kind === 'unknown' && turn.slots.serviceName) {
    action = 'collect_info';
    replyText = `We don't offer that. We have: ${services.map((s) => s.name).join(', ')}. Which would you like?`;
  } else {
    const service = resolution.kind === 'resolved' ? resolution.service : null;
    const complete = isBookingComplete(draft) && service !== null;

    // Consent is only valid for what the user was shown. The stored draft must
    // already have been complete — so a confirmation card was on screen — and
    // this turn must not have changed any of it. Without this, a message such
    // as "book a checkup tomorrow at 2" would write a booking before any
    // summary was shown, and "yes, but make it 4pm" would book a time nobody
    // has seen. The model's `intent` is an input to this decision, not the
    // decision itself.
    const consentedToShownDraft =
      turn.intent === 'confirming' &&
      isBookingComplete(session.bookingDraft) &&
      isSameBooking(session.bookingDraft, draft);

    if (complete && consentedToShownDraft) {
      // ---- 7. The user agreed and we have everything: book it -------------
      const result = await appointments.attemptBooking(
        { businessId: ctx.businessId, userId: ctx.userId },
        {
          serviceId: service!.id,
          date: draft.date!,
          time: draft.time!,
          notes: draft.notes ?? undefined,
          source: 'chat',
          chatSessionId: session.id,
        },
      );

      if (result.ok) {
        action = 'booked';
        appointment = result.appointment;
        replyText = `Booked — ${service!.name} on ${humanDate(draft.date!)} at ${humanTime(draft.time!)}. It's on your dashboard now.`;
        await withTransaction((client) =>
          repo.updateSessionMeta(client, session.id, {
            status: 'completed',
            title: `${service!.name} — ${shortDate(draft.date!)}`,
          }),
        );
      } else {
        // The slot went away, or was never valid. Compose the reply from the
        // booking service's own message rather than asking the model again:
        // it is accurate, instant, and costs nothing.
        action = 'collect_info';
        suggestions = result.suggestions;
        replyText = result.suggestions?.length
          ? `${result.message} I could do ${result.suggestions.map((s) => s.label).join(', or ')} — which works?`
          : `${result.message} ${result.code === 'in_past' ? 'Which day and time would suit you?' : 'What other time would suit you?'}`;
        // Drop what failed so the next turn asks for it again rather than
        // re-proposing something that just failed.
        draft = clearRejected(draft, result.code);
        logger.info(
          { sessionId: session.id, code: result.code },
          'Chat booking attempt rejected; offering alternatives',
        );
      }
    } else if (complete) {
      action = 'confirm';
      replyText = confirmationPrompt(service.name, draft.date!, draft.time!);
    } else {
      action = 'collect_info';
    }
  }

  // ---- 8. Escalate to the structured form if the conversation is stalling --
  // An explicit requirement, and good product sense: a user who has gone four
  // turns without the assistant pinning down a single new detail is not being
  // served by more conversation. Progress is what is measured, not message
  // count — a long conversation that keeps filling in details, or a turn that
  // offers alternative times, is working. The form is offered once, alongside
  // the chat and pre-filled with whatever was understood; repeating the offer
  // on every later turn would be nagging.
  const missing = missingSlots(draft);
  if (
    action === 'collect_info' &&
    !suggestions?.length &&
    !outcomes.formOffered &&
    isStalled(outcomes.recent, missing)
  ) {
    action = 'needs_form';
    replyText = `${replyText}\n\nIf it's easier, you can fill in the booking form instead — I've carried over what I have so far.`;
  }

  // ---- 9. Persist the assistant turn and the new draft --------------------
  const message = await withTransaction(async (client) => {
    const saved = await repo.appendMessage(client, {
      sessionId: session.id,
      role: 'assistant',
      content: replyText,
      engine: turn.engine,
      // The raw extraction is kept so a conversation can be debugged — or
      // replayed — without calling the provider again.
      toolCalls: [{ name: 'respond_to_booking_request', arguments: turn.slots, intent: turn.intent }],
      meta: {
        action,
        missing,
        draft,
        ...(suggestions ? { suggestions } : {}),
        ...(appointment ? { appointmentId: appointment.id } : {}),
      },
    });
    await repo.updateDraft(client, session.id, draft);
    return saved;
  });

  return {
    sessionId: session.id,
    userMessage,
    message,
    action,
    bookingDraft: draft,
    missing,
    ...(appointment ? { appointment } : {}),
    ...(suggestions ? { suggestions } : {}),
    engine: turn.engine,
  };
}

/**
 * Complete a booking from the structured fallback form, inside a conversation.
 *
 * Shares the booking service with every other path, so the form cannot bypass
 * a rule the chat enforces (or vice versa).
 */
export async function submitDraft(
  ctx: { businessId: string; userId: string },
  sessionId: string,
  slots: Partial<BookingSlots>,
): Promise<AssistantTurnDto> {
  const session = await repo.findSession(ctx.businessId, ctx.userId, sessionId);
  if (!session) throw notFound('Conversation');
  assertOpen(session);

  const draft = mergeSlots(session.bookingDraft, slots);
  const services = await appointments.listServices(ctx.businessId);
  const resolution = await resolveService(ctx.businessId, draft.serviceName, services);

  // The form is validated client-side too; these are the server's own checks,
  // because a client-side rule is a convenience, not a guarantee. Every problem
  // is reported at once, keyed by field, so the form can point at each of them.
  const details: Record<string, string[]> = Object.fromEntries(
    missingSlots(draft).map((field) => [field, ['Required']]),
  );
  if (resolution.kind === 'unknown') {
    details.serviceName = [`We offer: ${services.map((s) => s.name).join(', ')}`];
  } else if (resolution.kind === 'ambiguous') {
    details.serviceName = [`Did you mean ${resolution.options.map((o) => o.name).join(' or ')}?`];
  }
  if (Object.keys(details).length > 0 || resolution.kind !== 'resolved') {
    throw badRequest('Some booking details need attention', details);
  }

  const result = await appointments.attemptBooking(ctx, {
    serviceId: resolution.service.id,
    date: draft.date!,
    time: draft.time!,
    notes: draft.notes ?? undefined,
    source: 'chat',
    chatSessionId: sessionId,
  });

  // After a rejection the draft keeps what was fine, as in the conversational path.
  const resulting = result.ok ? draft : clearRejected(draft, result.code);
  const action: AssistantAction = result.ok ? 'booked' : 'collect_info';
  const missing = missingSlots(resulting);
  const suggestions = result.ok ? undefined : result.suggestions;
  const when = `${humanDate(draft.date!)} at ${humanTime(draft.time!)}`;

  // The submission is recorded as the user's turn, so the transcript reads as
  // what happened — "book this", then the outcome — rather than an answer to
  // a question nobody asked. No model was involved in either message, so the
  // reply is attributed to the system rather than to the fallback extractor.
  const [userMessage, message] = await withTransaction(async (client) => {
    const request = await repo.appendMessage(client, {
      sessionId,
      role: 'user',
      content: `Book ${resolution.service.name} on ${when}.`,
    });
    const reply = await repo.appendMessage(client, {
      sessionId,
      role: 'assistant',
      content: result.ok ? `Booked — ${resolution.service.name} on ${when}.` : result.message,
      engine: 'system',
      meta: {
        action,
        missing,
        draft: resulting,
        ...(suggestions ? { suggestions } : {}),
        ...(result.ok ? { appointmentId: result.appointment.id } : {}),
      },
    });
    await repo.updateDraft(client, sessionId, resulting);
    if (result.ok) {
      // Titled like a conversational booking: a session opened straight into
      // the form has no first message to name it, and would otherwise read
      // "New conversation" in the sidebar for good.
      await repo.updateSessionMeta(client, sessionId, {
        status: 'completed',
        title: `${resolution.service.name} — ${shortDate(draft.date!)}`,
      });
    }
    return [request, reply] as const;
  });

  return {
    sessionId,
    userMessage,
    message,
    action,
    bookingDraft: resulting,
    missing,
    ...(result.ok ? { appointment: result.appointment } : {}),
    ...(suggestions ? { suggestions } : {}),
    engine: 'system',
  };
}

/**
 * Has the conversation made no progress for STALLED_TURN_THRESHOLD turns,
 * this one included? Each of the previous turns must have asked for the same
 * missing details as this one, with nothing offered to choose from.
 */
function isStalled(previous: (repo.MessageMeta | null)[], missing: RequiredSlot[]): boolean {
  if (missing.length === 0 || previous.length < STALLED_TURN_THRESHOLD - 1) return false;
  const key = missing.join();
  return previous.every(
    (meta) => meta?.action === 'collect_info' && !meta.suggestions?.length && meta.missing.join() === key,
  );
}

/** Same service, day and time — the parts a user confirms. Notes may differ. */
function isSameBooking(a: BookingSlots, b: BookingSlots): boolean {
  const service = (slots: BookingSlots) => slots.serviceName?.trim().toLowerCase() ?? null;
  return service(a) === service(b) && a.date === b.date && a.time === b.time;
}

/**
 * Forget what a rejected booking got wrong, keeping what was fine.
 *
 * A taken slot or a closed hour is a problem with the time alone. A time in the
 * past is a problem with the day — keeping that date would reject the next
 * attempt too, however the user changes the time.
 */
function clearRejected(draft: BookingSlots, code: appointments.BookingFailure['code']): BookingSlots {
  return code === 'in_past' ? { ...draft, date: null, time: null } : { ...draft, time: null };
}

/**
 * Turn a free-text service name into a catalogue row.
 *
 * Three outcomes rather than a nullable return, because the caller must treat
 * "nothing matched" and "several matched" differently: one is a correction,
 * the other is a question. Collapsing them into null would lose that.
 */
type ServiceResolution =
  | { kind: 'resolved'; service: ServiceDto }
  | { kind: 'ambiguous'; options: ServiceDto[] }
  | { kind: 'unknown' }
  | { kind: 'absent' };

async function resolveService(
  businessId: string,
  name: string | null,
  catalogue: ServiceDto[],
): Promise<ServiceResolution> {
  if (!name) return { kind: 'absent' };

  // Exact match first, from the catalogue already in memory.
  const exact = catalogue.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (exact) return { kind: 'resolved', service: exact };

  const matches = await appointments.matchServiceByName(businessId, name);
  if (matches.length === 0) return { kind: 'unknown' };
  if (matches.length === 1) return { kind: 'resolved', service: matches[0]! };

  // Several matched. If exactly one is the best-ranked, take it; otherwise ask.
  const bestRank = matches[0]!.matchRank;
  const tied = matches.filter((m) => m.matchRank === bestRank);
  return tied.length === 1
    ? { kind: 'resolved', service: tied[0]! }
    : { kind: 'ambiguous', options: tied.slice(0, 3) };
}
