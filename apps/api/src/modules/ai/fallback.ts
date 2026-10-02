import * as chrono from 'chrono-node';
import type { BookingSlots } from '@appt/shared';
import { humanDate, humanTime, todayInZone, zonedNow } from '../../lib/time.js';
import { confirmationPrompt } from './copy.js';
import type { AiProvider, AssistantIntent, ProviderInput, ProviderOutput } from './provider.js';

/**
 * Deterministic fallback provider.
 *
 * This is NOT a toy stub. It is the reason the application still works when the
 * LLM is unreachable, rate-limited, or simply not configured — and that matters
 * twice over: an appointment booker that stops taking bookings because a third
 * party is down has failed at its actual job, and a reviewer with no API key
 * can still exercise the whole flow end to end.
 *
 * It handles the common path with ordinary code:
 *   - natural-language dates and times via chrono-node ("next Thursday", "2pm",
 *     "tomorrow at 2pm", "Oct 15 at 11:30"), resolved against the business's
 *     local clock, with vague ranges ("sometime next week") left deliberately
 *     unresolved so the next turn asks for a specific day
 *   - service names by substring and token overlap against the live catalogue
 *   - explicit confirmation ("yes", "book it", "go ahead")
 *   - templated replies that ask for exactly what is still missing
 *
 * What it does not do is hold an open-ended conversation. That is precisely the
 * part worth paying a model for, and the honest division of labour: the LLM
 * makes the interaction pleasant, this makes it reliable.
 */

const CONFIRM_PATTERNS = [
  /^(yes|yep|yeah|yup|sure|ok|okay|sounds good|perfect|great)\b/i,
  /\b(book|confirm)\s*(it|that|this|please)?\b/i,
  /\b(go ahead|that works|works for me|lets do it|let's do it|do it)\b/i,
];

const DECLINE_PATTERNS = [/^(no|nope|nah)\b/i, /\b(different|another|change|instead)\b/i];

/**
 * A negated or deferred request ("don't book it", "wait", "hold off") contains
 * the very words CONFIRM_PATTERNS looks for. It is checked first and wins:
 * refusing to book on a sentence that merely mentions booking costs one more
 * "yes"; booking on one the user meant as a refusal costs a real appointment.
 */
const NEGATION = /\b(don['’]?t|do not|not|never|no need|hold (?:off|on)|wait|rather not|stop)\b/i;

const CANCEL_PATTERNS = [/\bcancel\b/i, /\breschedul/i, /\bmove\b.*\bappointment\b/i];

/**
 * Expressions chrono resolves to a concrete day that the user did not actually
 * name. "sometime next week" comes back as a specific date with the day marked
 * certain, which would silently book someone for whichever day falls one week
 * out. A vague range must stay vague so the next turn asks "which day?".
 */
const VAGUE_RANGE =
  /^(next|this|coming|following)\s+(week|month|fortnight)$|^(sometime|soon|whenever|anytime)$/i;

export class FallbackProvider implements AiProvider {
  readonly engine = 'fallback' as const;
  readonly available = true;

  async respond(input: ProviderInput): Promise<ProviderOutput> {
    const startedAt = Date.now();
    const text = lastUserMessage(input);

    let intent: AssistantIntent = CANCEL_PATTERNS.some((p) => p.test(text)) ? 'cancelling' : 'collecting';
    const slots = extractSlots(text, input);

    // ---- confirmation --------------------------------------------------
    const merged: BookingSlots = {
      serviceName: slots.serviceName ?? input.draft.serviceName,
      date: slots.date ?? input.draft.date,
      time: slots.time ?? input.draft.time,
      notes: input.draft.notes,
    };
    const complete = Boolean(merged.serviceName && merged.date && merged.time);

    const isConfirming =
      complete &&
      !NEGATION.test(text) &&
      !DECLINE_PATTERNS.some((p) => p.test(text.trim())) &&
      CONFIRM_PATTERNS.some((p) => p.test(text.trim()));
    if (isConfirming) intent = 'confirming';

    return {
      reply: intent === 'cancelling' ? CANCEL_REPLY : composeReply(merged, input),
      slots,
      intent,
      engine: this.engine,
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** The message this turn is answering: the newest user entry in the history. */
export function lastUserMessage(input: Pick<ProviderInput, 'history'>): string {
  return [...input.history].reverse().find((m) => m.role === 'user')?.content ?? '';
}

type ExtractionContext = Pick<ProviderInput, 'timezone' | 'opensAt' | 'closesAt' | 'services'>;

/**
 * Read the booking slots one message states, by code alone.
 *
 * The fallback's whole understanding of a message. Its calendar half,
 * readCalendar, doubles as the cross-check on the model (see guardrails.ts).
 */
export function extractSlots(text: string, ctx: ExtractionContext): Partial<BookingSlots> {
  const slots: Partial<BookingSlots> = {};

  // ---- service -------------------------------------------------------
  const service = matchService(text, ctx.services.map((s) => s.name));
  if (service) slots.serviceName = service;

  // ---- date and time -------------------------------------------------
  const stated = readCalendar(text, ctx);
  if (stated.date) slots.date = stated.date;
  if (stated.time) slots.time = stated.time;

  // chrono resolves "October 12th" but not a bare "the 12th", which is how
  // people most often propose a date in conversation.
  if (!slots.date) {
    const ordinal = matchOrdinalDay(text, todayInZone(ctx.timezone));
    if (ordinal) slots.date = ordinal;
  }

  // chrono does not read a clock hour without "at" or am/pm ("around 3",
  // "4ish"), and a part of the day ahead of it ("afternoon around 3") would
  // otherwise win below and turn 3 o'clock into the 14:00 default.
  if (!slots.time) {
    const bare = matchBareHour(text);
    if (bare) slots.time = `${pad(resolveMeridiem(bare.hour, bare.minute, text, ctx))}:${pad(bare.minute)}`;
  }

  // "morning"/"afternoon"/"evening" with no clock time: offer a sensible
  // default inside opening hours rather than discarding the preference.
  if (!slots.time) {
    const vague = matchVagueTime(text, ctx.opensAt, ctx.closesAt);
    if (vague) slots.time = vague;
  }

  return slots;
}

const pad = (n: number | null | undefined): string => String(n ?? 0).padStart(2, '0');

/**
 * Match a service by substring, then by token overlap.
 *
 * Token overlap is what catches "whitening" for "Teeth Whitening" and "check
 * up" for "Routine Checkup" — the way people actually refer to services. Short
 * tokens are dropped so "a", "my" and "the" cannot match everything, and
 * neighbouring words are also tried joined, so "check up" and "check-up" count
 * as "checkup".
 *
 * When two services score equally the text did not choose between them, so
 * nothing is returned and the conversation asks. Taking the first would book
 * the wrong service whenever a catalogue has "Teeth Whitening" and "Teeth
 * Cleaning" and someone says "teeth".
 */
export function matchService(text: string, serviceNames: string[]): string | null {
  const lower = text.toLowerCase();

  for (const name of serviceNames) {
    if (lower.includes(name.toLowerCase())) return name;
  }

  const spoken = lower.match(/[a-z]+/g) ?? [];
  const words = new Set(spoken);
  for (let i = 0; i < spoken.length - 1; i += 1) words.add(`${spoken[i]}${spoken[i + 1]}`);

  const scored = serviceNames
    .map((name) => {
      const tokens = name.toLowerCase().match(/[a-z]{4,}/g) ?? [];
      const hits = tokens.filter((t) => words.has(t)).length;
      return { name, score: tokens.length ? hits / tokens.length : 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const [best, runnerUp] = scored;
  // Require at least half the service's significant words to appear, so an
  // incidental word does not select a service the user never mentioned.
  if (!best || best.score < 0.5 || runnerUp?.score === best.score) return null;
  return best.name;
}

/**
 * "the 12th" -> the next 12th that is today or later, as YYYY-MM-DD.
 *
 * Months without the requested day are skipped (the 31st lands on the next
 * 31-day month rather than on a rolled-over date in the wrong one).
 */
export function matchOrdinalDay(text: string, today: string): string | null {
  const match = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i);
  const day = Number(match?.[1]);
  if (!match || day < 1 || day > 31) return null;

  const [year, month] = today.split('-').map(Number) as [number, number];
  for (let offset = 0; offset < 13; offset += 1) {
    const candidate = new Date(Date.UTC(year, month - 1 + offset, day));
    // Date.UTC rolls an impossible day (Feb 30) into the next month.
    if (candidate.getUTCDate() !== day) continue;
    const iso = candidate.toISOString().slice(0, 10);
    if (iso >= today) return iso;
  }
  return null;
}

/**
 * The date and time chrono can read from a message with certainty.
 *
 * This is the calendar arithmetic ("next Wednesday" from today's date in the
 * business's zone) — the part the model cross-check trusts over the model.
 */
export function readCalendar(text: string, ctx: ExtractionContext): { date?: string; time?: string } {
  const found: { date?: string; time?: string } = {};

  // chrono resolves relative expressions against a reference instant. That
  // reference must be the business's wall clock, not the server's, or
  // "tomorrow" shifts by a day for a server in a different timezone.
  const reference = zonedNow(ctx.timezone);
  for (const { text: matched, start } of chrono.parse(text, reference, { forwardDate: true })) {
    // Skip ranges too vague to pin to a day (see VAGUE_RANGE).
    if (VAGUE_RANGE.test(matched.trim())) continue;
    // A date is only taken when chrono is actually confident about it.
    // Implied values are chrono filling in today's date to complete a
    // bare time like "2pm" — treating that as a stated date would book
    // people for today whenever they mentioned a time.
    const hasExplicitDate = start.isCertain('day') || start.isCertain('weekday') || start.isCertain('month');

    if (hasExplicitDate && !found.date) {
      found.date = `${start.get('year')}-${pad(start.get('month'))}-${pad(start.get('day'))}`;
    }
    if (start.isCertain('hour') && !found.time) {
      const hour = start.get('hour') ?? 0;
      const minute = start.get('minute') ?? 0;
      // chrono reads a bare "at 3" as 3 AM. Only an explicit am/pm settles it.
      const resolved = start.isCertain('meridiem') ? hour : resolveMeridiem(hour, minute, text, ctx);
      found.time = `${pad(resolved)}:${pad(minute)}`;
    }
  }
  return found;
}

const toMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/**
 * A clock hour said without "at" or am/pm: "around 3", "about 4:30", "3ish".
 * Hours followed by a unit ("3 days", "2 people") are not times.
 */
const BARE_HOUR =
  /\b(?:around|about|at|by|say|after|before|from)\s+(\d{1,2})(?::([0-5]\d))?(?:\s*-?ish)?(?!\s*(?:[ap]\.?m\b|st\b|nd\b|rd\b|th\b|[%/:\d]|days?\b|weeks?\b|months?\b|years?\b|mins?\b|minutes?\b|hours?\b|hrs?\b|people\b))/i;
const ISH_HOUR = /\b(\d{1,2})(?::([0-5]\d))?\s*-?ish\b/i;

export function matchBareHour(text: string): { hour: number; minute: number } | null {
  const match = text.match(BARE_HOUR) ?? text.match(ISH_HOUR);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  return hour >= 1 && hour <= 23 ? { hour, minute } : null;
}

/**
 * AM or PM, for an hour said without either ("at 3", "around 4").
 *
 * In order: a stated part of the day decides ("morning" keeps AM; "afternoon"
 * and "evening" mean PM); otherwise the reading that falls inside opening hours
 * wins; and when both or neither do, 1–7 means PM, because nobody asks a
 * dentist for 3 in the morning. 24-hour values and 12 are taken as said.
 */
export function resolveMeridiem(
  hour: number,
  minute: number,
  text: string,
  hours: Pick<ProviderInput, 'opensAt' | 'closesAt'>,
): number {
  if (hour === 0 || hour >= 12) return hour;
  const lower = text.toLowerCase();
  if (/\bmorning\b/.test(lower)) return hour;
  if (/\b(afternoon|evening|tonight|after lunch|after work)\b/.test(lower)) return hour + 12;

  const open = toMinutes(hours.opensAt);
  const close = toMinutes(hours.closesAt);
  const isOpen = (h: number) => h * 60 + minute >= open && h * 60 + minute < close;
  const am = isOpen(hour);
  const pm = isOpen(hour + 12);
  if (am !== pm) return am ? hour : hour + 12;
  return hour <= 7 ? hour + 12 : hour;
}

/** "morning" -> opening time, "afternoon" -> 14:00, "evening" -> late but inside hours. */
function matchVagueTime(text: string, opensAt: string, closesAt: string): string | null {
  const lower = text.toLowerCase();
  const fmt = (mins: number) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
  const open = toMinutes(opensAt);
  const close = toMinutes(closesAt);
  const clamp = (mins: number) => fmt(Math.min(Math.max(mins, open), Math.max(open, close - 60)));

  if (/\bmorning\b/.test(lower)) return clamp(Math.max(open, 9 * 60));
  if (/\b(afternoon|after lunch)\b/.test(lower)) return clamp(14 * 60);
  if (/\b(evening|after work|late)\b/.test(lower)) return clamp(close - 60);
  if (/\b(asap|as soon as possible|earliest|first thing)\b/.test(lower)) return clamp(open);
  return null;
}

const CANCEL_REPLY =
  'To cancel or change an appointment, open your dashboard and use the Cancel button on the booking. Anything else I can help with?';

/**
 * Templated replies. Plain, specific, and never pretend a booking exists.
 *
 * Exported because it is also the replacement when a model's own wording
 * cannot be trusted (see ai/guardrails.ts): every fact in it comes from the
 * draft, so it cannot contradict the draft.
 */
export function composeReply(
  merged: BookingSlots,
  input: Pick<ProviderInput, 'services' | 'opensAt' | 'closesAt'>,
): string {
  // Also the reply to a "yes" that changed something: the booking is not made
  // until the user agrees to the summary they have actually seen.
  if (merged.serviceName && merged.date && merged.time) {
    return confirmationPrompt(merged.serviceName, merged.date, merged.time);
  }

  const acknowledged = [
    merged.serviceName ? merged.serviceName : null,
    merged.date ? humanDate(merged.date) : null,
    merged.time ? humanTime(merged.time) : null,
  ].filter(Boolean);

  const prefix = acknowledged.length ? `Got it — ${acknowledged.join(', ')}. ` : '';
  const openingHours = `We're open ${humanTime(input.opensAt)} to ${humanTime(input.closesAt)}.`;

  if (!merged.serviceName) {
    const names = input.services.slice(0, 4).map((s) => s.name).join(', ');
    return `${prefix}Which service would you like? We offer: ${names}.`;
  }
  if (!merged.date && !merged.time) return `${prefix}What day and time would suit you? ${openingHours}`;
  if (!merged.date) return `${prefix}Which day would you like to come in?`;
  return `${prefix}What time works for you? ${openingHours}`;
}
