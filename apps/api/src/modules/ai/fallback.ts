import type { BookingSlots } from '@appt/shared';
import { answerAboutService, composeReply, offTopicPrompt } from './copy.js';
import {
  findClarification,
  isAffirmative,
  lastUserMessage,
  matchOrdinalDay,
  matchService,
  matchVagueTime,
  overridesInstructions,
  readDate,
  readDateAmbiguity,
  readTime,
  requestedService,
  withoutClarified,
  type ParseContext,
} from './parse.js';
import type { AiProvider, AssistantIntent, ProviderInput, ProviderOutput } from './provider.js';

/**
 * Deterministic provider: what serves every turn when the LLM is unreachable,
 * rate-limited or not configured, so bookings never stop because a third party
 * is down. It reads the common path with plain code (parse.ts) and asks for
 * exactly what is missing. It does not hold an open-ended conversation — that
 * is the part worth paying a model for.
 */

const CANCEL_PATTERNS = [/\bcancel\b/i, /\breschedul/i, /\bmove\b.*\bappointment\b/i];

const CANCEL_REPLY =
  'To cancel or change an appointment, open your dashboard and use the Cancel button on the booking. Anything else I can help with?';

export class FallbackProvider implements AiProvider {
  readonly engine = 'fallback' as const;
  readonly available = true;

  async respond(input: ProviderInput): Promise<ProviderOutput> {
    const startedAt = Date.now();
    const text = lastUserMessage(input);

    let intent: AssistantIntent = CANCEL_PATTERNS.some((p) => p.test(text)) ? 'cancelling' : 'collecting';
    const slots = extractSlots(text, input);
    const clarification = findClarification(text, input);

    const merged = withoutClarified(
      {
        serviceName: slots.serviceName ?? input.draft.serviceName,
        date: slots.date ?? input.draft.date,
        time: slots.time ?? input.draft.time,
        notes: input.draft.notes,
      },
      clarification,
    );
    const complete = Boolean(merged.serviceName && merged.date && merged.time);
    if (complete && isAffirmative(text)) intent = 'confirming';

    // A price/length question or an off-topic one is an aside (intent 'other'):
    // answered (or declined) first, then the chat service repeats the summary.
    const answer =
      intent === 'cancelling'
        ? null
        : overridesInstructions(text)
          ? offTopicPrompt(input.businessName)
          : answerAboutService(text, merged.serviceName, input.services);
    if (answer) intent = 'other';
    const reply =
      intent === 'cancelling'
        ? CANCEL_REPLY
        : answer && complete && !clarification
          ? answer
          : [answer, composeReply(merged, input, clarification)].filter(Boolean).join(' ');

    return {
      reply,
      slots,
      intent,
      engine: this.engine,
      latencyMs: Date.now() - startedAt,
      ...(clarification ? { clarify: clarification.fields } : {}),
      ...(clarification?.choice ? { clarification: clarification.choice } : {}),
    };
  }
}

/** The booking slots one message states, read by code alone: the fallback's whole understanding. */
export function extractSlots(text: string, ctx: ParseContext & Pick<ProviderInput, 'services'>): Partial<BookingSlots> {
  const slots: Partial<BookingSlots> = {};

  const service = matchService(text, ctx.services.map((s) => s.name)) ?? requestedService(text);
  if (service) slots.serviceName = service;

  // A date or time with two readings is not taken: findClarification asks.
  const dateAmbiguous = readDateAmbiguity(text, ctx) !== null;
  const date = dateAmbiguous ? null : (readDate(text, ctx) ?? matchOrdinalDay(text, ctx.today));
  if (date) slots.date = date;

  const time = readTime(text, ctx);
  if (time?.kind === 'clock') slots.time = time.time;
  // "morning"/"afternoon" with no clock time: a sensible default inside hours.
  if (!time) {
    const vague = matchVagueTime(text, ctx.opensAt, ctx.closesAt);
    if (vague) slots.time = vague;
  }

  return slots;
}
