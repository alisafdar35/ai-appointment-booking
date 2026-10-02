import * as chrono from 'chrono-node';
import { SLOT_GRID_MINUTES, type BookingSlots, type ServiceDto } from '@appt/shared';
import { humanDate, humanTime, wallClock } from '../../lib/time.js';
import { confirmationPrompt, formatPrice } from './copy.js';
import { openDaysPhrase } from './prompts.js';
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

/**
 * Consent is an allow-list: a message agrees only when it is made up entirely
 * of these short forms ("yes", "yes please, book it", "ok, sounds good!").
 * Looking for consent words anywhere was the bug: "Can you confirm the price
 * first?" contains "confirm" and booked. Anything else — a question, a "but",
 * a "wait", a change — is not agreement, whatever words it shares with one.
 * Wrongly refusing costs one more "yes"; wrongly accepting costs a booking.
 */
const AGREEMENT = [
  'yes', 'yes please', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'alright', 'all right', 'absolutely', 'of course',
  'correct', 'perfect', 'great', 'sounds good', 'sounds great', 'that works', 'works for me', 'thats right',
  'confirm', 'confirm it', 'confirm that', 'confirmed', 'book it', 'book that', 'book this', 'please book it',
  'go ahead', 'go for it', 'please do', 'do it', 'lets do it',
];
/** Politeness that may accompany agreement but is not agreement by itself. */
const COURTESY = ['please', 'thanks', 'thank you'];
const CONSENT_PHRASES = [...AGREEMENT, ...COURTESY]
  .map((phrase) => phrase.split(' '))
  .sort((a, b) => b.length - a.length);

/**
 * "don't", "not", "wait", "hold off": whatever the message names, it is not
 * asking for it. Used to say plainly that nothing was booked.
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
    const clarification = findClarification(text, input);

    // ---- confirmation --------------------------------------------------
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

    // "How much is it?" with a summary on screen is answered, and the chat
    // service repeats the summary after it (an aside, intent 'other').
    const answer = intent === 'cancelling' ? null : answerAboutService(text, merged.serviceName, input.services);
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
    };
  }
}

/**
 * Is this message plain agreement, and nothing else? A question mark rules it
 * out; otherwise every word must belong to the AGREEMENT/COURTESY forms, with
 * at least one real agreement. Used for both engines: the model's `confirming`
 * intent is only honoured when this agrees (see guardrails.ts), so readiness
 * to save is decided by code.
 */
export function isAffirmative(text: string): boolean {
  if (text.includes('?')) return false;
  const words = text
    .toLowerCase()
    .replace(/['’]/g, '')
    // Trivial punctuation and emoji ("Yes!", "ok 👍") carry no meaning here.
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let agreed = false;
  for (let i = 0; i < words.length; ) {
    const phrase = CONSENT_PHRASES.find((p) => p.every((word, k) => words[i + k] === word));
    if (!phrase) return false;
    agreed ||= AGREEMENT.includes(phrase.join(' '));
    i += phrase.length;
  }
  return agreed;
}

const PRICE_QUESTION = /\b(price|prices|cost|costs|how much|fee|charge)\b/i;
const DURATION_QUESTION = /\b(how long|duration|minutes|mins)\b/i;

/**
 * The catalogue's answer to a question about the service's price or length
 * ("Can you confirm the price first?", "is that 60 minutes?"), or null when
 * the message asks neither or no service is known. Facts come from the
 * catalogue, never from a model, so the answer cannot be wrong about them.
 */
export function answerAboutService(
  text: string,
  serviceName: string | null,
  services: Pick<ServiceDto, 'name' | 'durationMinutes' | 'priceCents'>[],
): string | null {
  const price = PRICE_QUESTION.test(text);
  if (!price && !DURATION_QUESTION.test(text)) return null;
  const service = services.find((s) => s.name.toLowerCase() === serviceName?.toLowerCase());
  if (!service) return null;
  const cost = service.priceCents > 0 ? `costs ${formatPrice(service.priceCents)}` : 'has no charge';
  return `${service.name} takes ${service.durationMinutes} minutes and ${cost}.`;
}

/** "don't", "not", "wait", "hold off": whatever the message names, it is not asking for it. */
export const negates = (text: string): boolean => NEGATION.test(text);

/** The message this turn is answering: the newest user entry in the history. */
export function lastUserMessage(input: Pick<ProviderInput, 'history'>): string {
  return [...input.history].reverse().find((m) => m.role === 'user')?.content ?? '';
}

type ExtractionContext = Pick<ProviderInput, 'opensAt' | 'closesAt' | 'openDays' | 'services' | 'today' | 'nowTime'>;

/**
 * Read the booking slots one message states, by code alone.
 *
 * The fallback's whole understanding of a message. Its calendar half,
 * readDate and readTime, doubles as the cross-check on the model (see guardrails.ts).
 */
export function extractSlots(text: string, ctx: ExtractionContext): Partial<BookingSlots> {
  const slots: Partial<BookingSlots> = {};

  // ---- service -------------------------------------------------------
  const service = matchService(text, ctx.services.map((s) => s.name));
  if (service) slots.serviceName = service;

  // ---- date and time -------------------------------------------------
  // A date or time with two readings is not taken at all: findClarification
  // asks which one was meant.
  const dateAmbiguous = readDateAmbiguity(text, ctx) !== null;
  const date = dateAmbiguous ? null : readDate(text, ctx);
  if (date) slots.date = date;

  // chrono resolves "October 12th" but not a bare "the 12th", which is how
  // people most often propose a date in conversation.
  if (!slots.date && !dateAmbiguous) {
    const ordinal = matchOrdinalDay(text, ctx.today);
    if (ordinal) slots.date = ordinal;
  }

  const time = readTime(text, ctx);
  if (time?.kind === 'clock') slots.time = time.time;

  // "morning"/"afternoon"/"evening" with no clock time: offer a sensible
  // default inside opening hours rather than discarding the preference.
  if (!time) {
    const vague = matchVagueTime(text, ctx.opensAt, ctx.closesAt);
    if (vague) slots.time = vague;
  }

  return slots;
}

const pad = (n: number | null | undefined): string => String(n ?? 0).padStart(2, '0');

/**
 * chrono's reading of a message, resolved against the business's wall clock as
 * this turn sees it (`today`, `nowTime`), not the server's: "tomorrow" must not
 * shift by a day for a server in another timezone, and every check on one turn
 * must agree on which day "today" is.
 */
const parseDates = (text: string, ctx: Pick<ExtractionContext, 'today' | 'nowTime'>) =>
  chrono.parse(text, wallClock(ctx.today, ctx.nowTime), { forwardDate: true });

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
 * The date chrono can read from a message with certainty.
 *
 * This is the calendar arithmetic ("next Wednesday" from today's date in the
 * business's zone) — the part the model cross-check trusts over the model.
 */
export function readDate(
  text: string,
  ctx: Pick<ExtractionContext, 'opensAt' | 'closesAt' | 'openDays' | 'today' | 'nowTime'>,
): string | null {
  for (const { text: matched, start } of parseDates(text, ctx)) {
    // Skip ranges too vague to pin to a day (see VAGUE_RANGE).
    if (VAGUE_RANGE.test(matched.trim())) continue;
    // A date is only taken when chrono is actually confident about it.
    // Implied values are chrono filling in today's date to complete a
    // bare time like "2pm" — treating that as a stated date would book
    // people for today whenever they mentioned a time.
    if (start.isCertain('day') || start.isCertain('weekday') || start.isCertain('month')) {
      const date = `${start.get('year')}-${pad(start.get('month'))}-${pad(start.get('day'))}`;
      // chrono reads "Friday" said on a Friday as today. Once today can no
      // longer be booked it can only mean a week today; while it can,
      // readDateAmbiguity asks instead.
      return date === ctx.today && namesWeekdayOnly(matched, start) && !todayStillBookable(text, ctx)
        ? addDays(ctx.today, 7)
        : date;
    }
  }
  return null;
}

/**
 * A clock time the message states, as HH:MM, or both readings of an hour said
 * without AM or PM when they cannot be told apart (see resolveMeridiem). An
 * ambiguous hour is never stored: the user is asked which one they meant.
 */
export type StatedTime =
  | { kind: 'clock'; time: string }
  | { kind: 'ambiguous'; readings: [am: string, pm: string]; bookable: boolean };

export function readTime(
  text: string,
  ctx: Pick<ExtractionContext, 'today' | 'nowTime' | 'opensAt' | 'closesAt'>,
): StatedTime | null {
  const clock = (hour: number, minute: number, meridiemStated: boolean): StatedTime => {
    // chrono reads a bare "at 3" as 3 AM. Only an explicit am/pm settles it.
    const placed = meridiemStated ? hour : resolveMeridiem(hour, minute, text, ctx);
    if (placed !== null) return { kind: 'clock', time: `${pad(placed)}:${pad(minute)}` };
    const am = `${pad(hour)}:${pad(minute)}`;
    return { kind: 'ambiguous', readings: [am, `${pad(hour + 12)}:${pad(minute)}`], bookable: isOpenAt(am, ctx) };
  };

  for (const { text: matched, start } of parseDates(text, ctx)) {
    // A leading zero ("08:15") is 24-hour notation, which settles the hour.
    const settled = start.isCertain('meridiem') || /\b0\d:[0-5]\d/.test(matched);
    if (start.isCertain('hour')) return clock(start.get('hour') ?? 0, start.get('minute') ?? 0, settled);
  }
  // chrono does not read a clock hour without "at" or am/pm ("around 3",
  // "4ish"), and a part of the day ahead of it ("afternoon around 3") would
  // otherwise win in extractSlots and turn 3 o'clock into the 14:00 default.
  const bare = matchBareHour(text);
  return bare ? clock(bare.hour, bare.minute, false) : null;
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
 * AM or PM, for an hour said without either ("at 3", "around 4"), or null when
 * the hour cannot be placed and the user must be asked.
 *
 * A stated part of the day decides ("morning" keeps AM; "afternoon" and
 * "evening" mean PM). Otherwise the hour is placed only when exactly one
 * reading can start an appointment inside opening hours: "at 3" is 3 PM and
 * "at 10" is 10 AM for a 9–5 business, and the confirmation shows which. When
 * neither reading can ("at 5": 5 AM is before opening, 5 PM is closing time)
 * or both can (a business open 8 AM to 10 PM, "at 9"), picking one would book
 * a time the user may not have meant, so null. 24-hour values and 12 are taken
 * as said.
 */
export function resolveMeridiem(
  hour: number,
  minute: number,
  text: string,
  hours: Pick<ProviderInput, 'opensAt' | 'closesAt'>,
): number | null {
  if (hour === 0 || hour >= 12) return hour;
  const part = statedPartOfDay(text);
  if (part) return part === 'am' ? hour : hour + 12;

  const am = isOpenAt(`${pad(hour)}:${pad(minute)}`, hours);
  const pm = isOpenAt(`${pad(hour + 12)}:${pad(minute)}`, hours);
  if (am === pm) return null;
  return am ? hour : hour + 12;
}

/** Can an appointment start at this HH:MM? Opening time inclusive, closing time exclusive. */
function isOpenAt(time: string, hours: Pick<ProviderInput, 'opensAt' | 'closesAt'>): boolean {
  const at = toMinutes(time);
  return at >= toMinutes(hours.opensAt) && at < toMinutes(hours.closesAt);
}

/**
 * A date written as two small numbers ("03/04") reads as March 4 in the US and
 * 3 April almost everywhere else. A weekday named on that same weekday ("on
 * Friday", said on a Friday) may mean today or a week today — but only when
 * both can actually be booked (see todayStillBookable); otherwise readDate
 * takes a week today. Both readings are returned, earlier first, so
 * the user can be asked; null when the text names a date one way only.
 */
export function readDateAmbiguity(
  text: string,
  ctx: Pick<ExtractionContext, 'opensAt' | 'closesAt' | 'openDays' | 'today' | 'nowTime'>,
): [string, string] | null {
  const numeric = text.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/);
  if (numeric) {
    const [a, b] = [Number(numeric[1]), Number(numeric[2])];
    if (a >= 1 && b >= 1 && a <= 12 && b <= 12 && a !== b) {
      const year = numeric[3] ? Number(numeric[3].padStart(4, '20')) : null;
      const readings = [nextOccurrence(a, b, year, ctx.today), nextOccurrence(b, a, year, ctx.today)].sort();
      return readings as [string, string];
    }
  }

  // chrono reads a weekday named on that weekday as today; taking today
  // silently is as much a guess as skipping it.
  const todayWeekday = new Date(`${ctx.today}T12:00:00Z`).getUTCDay();
  for (const { text: matched, start } of parseDates(text, ctx)) {
    if (namesWeekdayOnly(matched, start) && start.get('weekday') === todayWeekday) {
      return todayStillBookable(text, ctx) ? [ctx.today, addDays(ctx.today, 7)] : null;
    }
  }
  return null;
}

/** "Friday" or "this Friday": a weekday with no date and no "next" to place it. */
const namesWeekdayOnly = (matched: string, start: chrono.ParsedComponents): boolean =>
  start.isCertain('weekday') && !start.isCertain('day') && !/\b(next|following|coming)\b/i.test(matched);

/**
 * Can today still be booked, for a message naming today's weekday? A week
 * today is the same weekday, so it is bookable exactly when that weekday is an
 * open day. Today also needs a start time left: an appointment slot on the
 * grid after now and before closing, and, if the message states a time, that
 * time still ahead. When today cannot be booked there is nothing to ask: a
 * week today is the only reading left (and on a closed weekday the booking
 * check then says so).
 */
function todayStillBookable(
  text: string,
  ctx: Pick<ExtractionContext, 'opensAt' | 'closesAt' | 'openDays' | 'today' | 'nowTime'>,
): boolean {
  const isoWeekday = ((new Date(`${ctx.today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  if (!ctx.openDays.includes(isoWeekday)) return false;

  // Slots start on the grid from opening time, and only strictly after now.
  const [now, opens] = [toMinutes(ctx.nowTime), toMinutes(ctx.opensAt)];
  const nextSlot = now < opens ? opens : opens + (Math.floor((now - opens) / SLOT_GRID_MINUTES) + 1) * SLOT_GRID_MINUTES;
  if (nextSlot >= toMinutes(ctx.closesAt)) return false;

  const stated = readTime(text, ctx);
  return stated?.kind !== 'clock' || toMinutes(stated.time) > now;
}

/** The first `month`/`day` on or after today, or in `year` when one was written. */
function nextOccurrence(month: number, day: number, year: number | null, today: string): string {
  const iso = (y: number) => `${y}-${pad(month)}-${pad(day)}`;
  if (year) return iso(year);
  const thisYear = Number(today.slice(0, 4));
  return iso(thisYear) >= today ? iso(thisYear) : iso(thisYear + 1);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * What the latest message left open, and the question that settles it. The
 * same check runs on the fallback's reading and on a model's answer (see
 * guardrails.ts), so both engines ask rather than guess, in the same words.
 */
export interface Clarification {
  fields: ('date' | 'time')[];
  question: string;
}

export function findClarification(
  text: string,
  ctx: Pick<ExtractionContext, 'opensAt' | 'closesAt' | 'openDays' | 'today' | 'nowTime'>,
): Clarification | null {
  const fields: Clarification['fields'] = [];
  const questions: string[] = [];

  const dates = readDateAmbiguity(text, ctx);
  if (dates) {
    fields.push('date');
    questions.push(`Did you mean ${humanDate(dates[0])} or ${humanDate(dates[1])}?`);
  }

  const time = readTime(text, ctx);
  if (time?.kind === 'ambiguous') {
    const [am, pm] = time.readings.map(humanTime) as [string, string];
    fields.push('time');
    questions.push(
      time.bookable
        ? `Did you mean ${am} or ${pm}?`
        : `Did you mean ${am} or ${pm}? We're open ${humanTime(ctx.opensAt)} to ${humanTime(ctx.closesAt)}, so neither can start an appointment. What time in those hours suits you?`,
    );
  }

  return fields.length ? { fields, question: questions.join(' ') } : null;
}

/** The draft with the fields a clarification reopened set back to unknown. */
export function withoutClarified(draft: BookingSlots, clarification: Clarification | null): BookingSlots {
  const reopened = { ...draft };
  for (const field of clarification?.fields ?? []) reopened[field] = null;
  return reopened;
}

/** "morning" keeps an hour in the AM; "afternoon", "evening" and the like move it to the PM. */
function statedPartOfDay(text: string): 'am' | 'pm' | null {
  const lower = text.toLowerCase();
  if (/\bmorning\b/.test(lower)) return 'am';
  if (/\b(afternoon|evening|tonight|after lunch|after work)\b/.test(lower)) return 'pm';
  return null;
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
  input: Pick<ProviderInput, 'services' | 'opensAt' | 'closesAt' | 'openDays'>,
  clarification: Clarification | null = null,
): string {
  // Also the reply to a "yes" that changed something: the booking is not made
  // until the user agrees to the summary they have actually seen.
  if (merged.serviceName && merged.date && merged.time && !clarification) {
    return confirmationPrompt(merged.serviceName, merged.date, merged.time);
  }

  const acknowledged = [
    merged.serviceName ? merged.serviceName : null,
    merged.date ? humanDate(merged.date) : null,
    merged.time ? humanTime(merged.time) : null,
  ].filter(Boolean);

  const prefix = acknowledged.length ? `Got it — ${acknowledged.join(', ')}. ` : '';
  // Days are named only when some are closed: "every day" adds nothing to a question.
  const days = input.openDays.length < 7 ? `${openDaysPhrase(input.openDays)}, ` : '';
  const openingHours = `We're open ${days}${humanTime(input.opensAt)} to ${humanTime(input.closesAt)}.`;
  if (clarification) return `${prefix}${clarification.question}`;

  if (!merged.serviceName) {
    const names = input.services.slice(0, 4).map((s) => s.name).join(', ');
    // Nothing known yet: ask for all of it at once rather than over three turns.
    if (!merged.date && !merged.time) {
      return `Which service would you like, and what day and time suit you? We offer: ${names}. ${openingHours}`;
    }
    return `${prefix}Which service would you like? We offer: ${names}.`;
  }
  if (!merged.date && !merged.time) return `${prefix}What day and time would suit you? ${openingHours}`;
  if (!merged.date) return `${prefix}Which day would you like to come in?`;
  return `${prefix}What time works for you? ${openingHours}`;
}
