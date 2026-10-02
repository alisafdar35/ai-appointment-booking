import {
  isBookingComplete,
  mergeSlots,
  missingSlots,
  type AppointmentDto,
  type AssistantAction,
  type AssistantTurnDto,
  type BookingSlots,
  type BookingSuggestion,
  type ChatSessionDto,
  type ClarificationDto,
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
import {
  confirmationPrompt,
  generateAssistantTurn,
  heldPrompt,
  negates,
  PART_OF_DAY_WINDOW,
  statedPartOfDay,
  type ProviderInput,
  type ProviderOutput,
} from '../ai/index.js';
import * as appointments from '../appointments/service.js';
import * as repo from './repository.js';

/**
 * Conversation orchestration.
 *
 *   The AI           — reads what the user wrote; returns slots and a sentence.
 *   This layer       — owns the state machine: resolves slots to real records,
 *                      decides what happens next, persists it.
 *   The booking layer — enforces the rules and writes the row.
 *
 * The model is an input, not a decision maker: it cannot book, see another
 * tenant's data, or choose what the UI renders.
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
  return input.sessionId
    ? inSessionOrder(input.sessionId, () => handleTurn(ctx, input, hooks))
    : handleTurn(ctx, input, hooks);
}

/**
 * One turn at a time per conversation, in arrival order. Overlapping turns
 * would both start from the same draft and the later write would undo the
 * earlier ("whitening" then "at 3pm" lost the service), and two "yes"es would
 * race to book. The queue is per process; across instances the session row
 * lock and the EXCLUDE constraints still hold.
 */
const sessionQueues = new Map<string, Promise<unknown>>();

async function inSessionOrder<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  sessionQueues.set(sessionId, current);
  try {
    return await current;
  } finally {
    // Only the last queued turn may remove the entry, or a later one would lose its place.
    if (sessionQueues.get(sessionId) === current) sessionQueues.delete(sessionId);
  }
}

type TurnCtx = { businessId: string; userId: string; requestId: string };

/** What a turn decided: the reply, the UI action and the draft to store. */
interface Decision {
  action: AssistantAction;
  replyText: string;
  draft: BookingSlots;
  appointment?: AppointmentDto;
  suggestions?: BookingSuggestion[];
  clarification?: ClarificationDto;
}

async function handleTurn(
  ctx: TurnCtx,
  input: SendMessageInput,
  hooks: { onGenerating?: (sessionId: string) => void },
): Promise<AssistantTurnDto> {
  const [business, firstName] = await Promise.all([
    repo.findBusinessContext(ctx.businessId),
    repo.findFirstName(ctx.businessId, ctx.userId),
  ]);
  if (!business) throw notFound('Business');

  // 1. Resolve the session and store the user's message before anything slow.
  const session = await openSession(ctx, input);
  const userMessage = await recordUserMessage(session, input.content);

  // 2. Ask the assistant, with the stored draft re-stated as context.
  const [history, services, outcomes] = await Promise.all([
    repo.recentTurns(session.id, env.AI_HISTORY_TURNS),
    appointments.listServices(ctx.businessId),
    repo.recentOutcomes(session.id, STALLED_TURN_THRESHOLD - 1),
  ]);
  const providerInput: ProviderInput = {
    businessName: business.name,
    timezone: business.timezone,
    opensAt: business.opensAt,
    closesAt: business.closesAt,
    openDays: business.openDays,
    today: todayInZone(business.timezone),
    nowTime: nowTimeInZone(business.timezone),
    services,
    draft: session.bookingDraft,
    customerName: firstName ?? 'there',
    history,
    requestId: ctx.requestId,
  };
  hooks.onGenerating?.(session.id);
  const turn = await generateAssistantTurn(providerInput, { businessId: ctx.businessId, sessionId: session.id });

  // 3. Merge the (already guard-checked) slots and resolve the service.
  const { draft, resolution } = await mergeTurn(ctx.businessId, session.bookingDraft, turn, services);

  // 4. Decide what happens next, then offer the form if the chat is stalling.
  const decision = offerFormIfStalled(
    await decideAction({ ctx, session, turn, draft, resolution, services, history, content: input.content }),
    outcomes,
  );

  // 5. Persist the assistant turn and the new draft together.
  const missing = missingSlots(decision.draft);
  const message = await withTransaction(async (client) => {
    const saved = await repo.appendMessage(client, {
      sessionId: session.id,
      role: 'assistant',
      content: decision.replyText,
      engine: turn.engine,
      // The raw extraction, so a conversation can be debugged or replayed without the provider.
      toolCalls: [{ name: 'respond_to_booking_request', arguments: turn.slots, intent: turn.intent }],
      meta: turnMeta(decision, missing),
    });
    await repo.updateDraft(client, session.id, decision.draft);
    return saved;
  });

  return {
    sessionId: session.id,
    userMessage,
    message,
    action: decision.action,
    bookingDraft: decision.draft,
    missing,
    ...(decision.appointment ? { appointment: decision.appointment } : {}),
    ...(decision.suggestions ? { suggestions: decision.suggestions } : {}),
    ...(decision.clarification ? { clarification: decision.clarification } : {}),
    engine: turn.engine,
  };
}

/** The session this message belongs to, or a new one titled by it. */
async function openSession(ctx: TurnCtx, input: SendMessageInput): Promise<ChatSessionDto> {
  if (input.sessionId) {
    const existing = await repo.findSession(ctx.businessId, ctx.userId, input.sessionId);
    if (!existing) throw notFound('Conversation');
    assertOpen(existing);
    return existing;
  }
  // The first message becomes the title: readable without another model call.
  return withTransaction((client) =>
    repo.createSession(client, { businessId: ctx.businessId, userId: ctx.userId, title: titleFromMessage(input.content) }),
  );
}

/**
 * Stored before the provider is called, so it survives a failed or abandoned
 * request. A session opened empty (the form, POST /chat/sessions) is titled
 * by the first message typed into it.
 */
async function recordUserMessage(session: ChatSessionDto, content: string) {
  return withTransaction(async (client) => {
    if (session.title === DEFAULT_SESSION_TITLE) await repo.updateSessionTitle(client, session.id, titleFromMessage(content));
    return repo.appendMessage(client, { sessionId: session.id, role: 'user', content });
  });
}

/**
 * The turn's slots over the stored draft, with the service name resolved to a
 * catalogue row. An absent field means "not mentioned", not "cleared" (see
 * mergeSlots); a field the message reopened without settling is cleared, so
 * the summary still on screen for the old value cannot be agreed to.
 */
async function mergeTurn(
  businessId: string,
  stored: BookingSlots,
  turn: ProviderOutput,
  services: ServiceDto[],
): Promise<{ draft: BookingSlots; resolution: ServiceResolution }> {
  let draft = mergeSlots(stored, turn.slots);
  for (const field of turn.clarify ?? []) draft = { ...draft, [field]: null };

  const resolution = await resolveService(businessId, draft.serviceName, services);
  if (resolution.kind === 'unknown' && draft.serviceName) draft = { ...draft, serviceName: null };
  // The catalogue's own name, not the model's near-miss ("whitening").
  if (resolution.kind === 'resolved') draft = { ...draft, serviceName: resolution.service.name };
  if (resolution.kind === 'ambiguous') draft = { ...draft, serviceName: null };
  return { draft, resolution };
}

async function decideAction(args: {
  ctx: TurnCtx;
  session: ChatSessionDto;
  turn: ProviderOutput;
  draft: BookingSlots;
  resolution: ServiceResolution;
  services: ServiceDto[];
  history: ProviderInput['history'];
  content: string;
}): Promise<Decision> {
  const { ctx, session, turn, draft, resolution, services } = args;
  const booking = { businessId: ctx.businessId, userId: ctx.userId };

  if (resolution.kind === 'ambiguous') {
    return { action: 'collect_info', draft, replyText: `Did you mean ${resolution.options.map((o) => o.name).join(' or ')}?` };
  }
  if (resolution.kind === 'unknown' && turn.slots.serviceName) {
    return {
      action: 'collect_info',
      draft,
      replyText: `We don't offer that. We have: ${services.map((s) => s.name).join(', ')}. Which would you like?`,
    };
  }

  const service = resolution.kind === 'resolved' ? resolution.service : null;
  if (!service || !isBookingComplete(draft)) {
    return { action: 'collect_info', draft, replyText: turn.reply, ...(await chipsFor(args, service)) };
  }

  // Consent counts only for what the user was shown: the stored draft was
  // already complete (a summary was on screen) and this turn changed none of
  // it. Otherwise "yes, but make it 4pm" would book a time nobody has seen.
  const unchanged = isBookingComplete(session.bookingDraft) && isSameBooking(session.bookingDraft, draft);
  if (turn.intent === 'confirming' && unchanged) {
    const result = await appointments.attemptBooking(booking, {
      serviceId: service.id,
      date: draft.date!,
      time: draft.time!,
      notes: draft.notes ?? undefined,
      source: 'chat',
      chatSessionId: session.id,
    });
    if (!result.ok) {
      // The slot went away, or passed, after the summary was shown.
      logger.info({ sessionId: session.id, code: result.code }, 'Chat booking attempt rejected; offering alternatives');
      return refusalTurn(draft, result);
    }
    // The booking closed the session in its own transaction (bookInSession).
    await withTransaction((client) =>
      repo.updateSessionTitle(client, session.id, `${service.name} — ${shortDate(draft.date!)}`),
    );
    return {
      action: 'booked',
      draft,
      appointment: result.appointment,
      replyText: `Booked — ${service.name} on ${humanDate(draft.date!)} at ${humanTime(draft.time!)}. It's on your dashboard now.`,
    };
  }

  // Check the slot before summarising it: a "Just to confirm…" for a time the
  // booking would refuse invites a "yes" that can only be turned down.
  const refused = await appointments.checkBooking(booking, { serviceId: service.id, date: draft.date!, time: draft.time! });
  if (refused) {
    logger.info({ sessionId: session.id, code: refused.code }, 'Chat draft refused before confirmation');
    return refusalTurn(draft, refused);
  }

  // "Don't book anything yet" against the summary shown: say nothing was booked.
  const held = unchanged && negates(args.content);
  let replyText = (held ? heldPrompt : confirmationPrompt)(service.name, draft.date!, draft.time!);
  // An aside ("do you have parking?") gets its short answer, then the
  // code-worded summary, so consent is still given to the exact slots.
  if (unchanged && !held && turn.intent === 'other') replyText = `${turn.reply} ${replyText}`;
  return { action: 'confirm', draft, replyText };
}

/**
 * Chips that answer the question this reply asks: the two readings of an
 * ambiguous detail, or, when only the time is missing, the first free times
 * that day — within the part of the day the user asked for, if they said one.
 */
async function chipsFor(
  args: { ctx: TurnCtx; turn: ProviderOutput; draft: BookingSlots; history: ProviderInput['history'] },
  service: ServiceDto | null,
): Promise<Pick<Decision, 'suggestions' | 'clarification'>> {
  if (args.turn.clarification) return { clarification: args.turn.clarification };
  if (!service || !args.draft.date || args.draft.time) return {};

  const part = [...args.history]
    .reverse()
    .map((m) => (m.role === 'user' ? statedPartOfDay(m.content) : null))
    .find((p) => p !== null);
  const suggestions = await appointments.freeTimes(
    { businessId: args.ctx.businessId, userId: args.ctx.userId },
    service.id,
    args.draft.date,
    part ? { window: PART_OF_DAY_WINDOW[part] } : {},
  );
  return suggestions.length ? { suggestions } : {};
}

/**
 * The form is offered once, pre-filled, when STALLED_TURN_THRESHOLD turns in a
 * row asked for the same details with nothing offered to pick. Progress is
 * measured, not message count; repeating the offer would be nagging.
 */
function offerFormIfStalled(decision: Decision, outcomes: Awaited<ReturnType<typeof repo.recentOutcomes>>): Decision {
  const offersChoice = Boolean(decision.suggestions?.length || decision.clarification);
  if (decision.action !== 'collect_info' || offersChoice || outcomes.formOffered) return decision;
  if (!isStalled(outcomes.recent, missingSlots(decision.draft))) return decision;
  return {
    ...decision,
    action: 'needs_form',
    replyText: `${decision.replyText}\n\nIf it's easier, you can fill in the booking form instead — I've carried over what I have so far.`,
  };
}

/** What is stored with an assistant message so a reload restores the same UI. */
function turnMeta(decision: Decision, missing: RequiredSlot[]): repo.MessageMeta {
  return {
    action: decision.action,
    missing,
    draft: decision.draft,
    ...(decision.suggestions ? { suggestions: decision.suggestions } : {}),
    ...(decision.clarification ? { clarification: decision.clarification } : {}),
    ...(decision.appointment ? { appointmentId: decision.appointment.id } : {}),
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
  // Queued with the conversation's chat turns: a form submitted while a reply
  // is still being written must not interleave its draft write with that turn's.
  return inSessionOrder(sessionId, () => submitDraftNow(ctx, sessionId, slots));
}

async function submitDraftNow(
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
    // Typed into the form, not understood from chat: the badge must say so.
    source: 'form',
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
      await repo.updateSessionTitle(client, sessionId, `${resolution.service.name} — ${shortDate(draft.date!)}`);
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
 * The turn for a refused slot, whether refused on "yes" or before the summary.
 * The reply is the booking service's own message rather than the model's: it
 * is accurate, instant, and costs nothing. What failed is dropped from the
 * draft so the next turn asks for it again rather than re-proposing it.
 */
function refusalTurn(draft: BookingSlots, failure: appointments.BookingFailure): Decision {
  const replyText = failure.suggestions?.length
    ? `${failure.message} I could do ${failure.suggestions.map((s) => s.label).join(', or ')} — which works?`
    : `${failure.message} ${clearsDay(failure.code) ? 'Which day and time would suit you?' : 'What other time would suit you?'}`;
  return {
    action: 'collect_info',
    replyText,
    draft: clearRejected(draft, failure.code),
    ...(failure.suggestions ? { suggestions: failure.suggestions } : {}),
  };
}

/**
 * Forget what a rejected booking got wrong, keeping what was fine.
 *
 * A taken slot, a closed hour or a time the clocks skip is a problem with the
 * time alone. A time in the past or a day the business is closed is a problem
 * with the day — keeping that date would reject the next attempt too, however
 * the user changes the time.
 */
function clearRejected(draft: BookingSlots, code: appointments.BookingFailure['code']): BookingSlots {
  return clearsDay(code) ? { ...draft, date: null, time: null } : { ...draft, time: null };
}

const clearsDay = (code: appointments.BookingFailure['code']): boolean => code === 'in_past' || code === 'closed_day';

/**
 * Turn a free-text service name into a catalogue row.
 *
 * Four outcomes rather than a nullable return, because the caller must treat
 * "no name given", "nothing matched" and "several matched" differently: the
 * first asks for a service, the second is a correction, the third a question.
 * Collapsing them into null would lose that.
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
