import * as chrono from 'chrono-node';
import { SLOT_GRID_MINUTES, type BookingSlots, type ClarificationDto } from '@appt/shared';
import { humanDate, humanTime, wallClock } from '../../lib/time.js';
import type { ProviderInput } from './provider.js';

/**
 * Reading a message by code alone: dates, times, services, consent, negation.
 *
 * Pure functions shared by the deterministic provider (fallback.ts), the
 * checks on a model answer (guardrails.ts) and the chat service. Calendar
 * arithmetic lives here because it is what code is reliable at and language
 * models are not.
 */

export type PartOfDay = 'morning' | 'afternoon' | 'evening';

export type ParseContext = Pick<ProviderInput, 'opensAt' | 'closesAt' | 'openDays' | 'today' | 'nowTime'>;

// ---------------------------------------------------------------------------
// Consent and negation
// ---------------------------------------------------------------------------

/**
 * Consent is an allow-list: a message agrees only when it is made up entirely
 * of these short forms. Looking for consent words anywhere was a live bug:
 * "Can you confirm the price first?" contains "confirm" and booked. Wrongly
 * refusing costs one more "yes"; wrongly accepting costs a booking.
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
 * Is this message plain agreement, and nothing else? A question mark rules it
 * out; otherwise every word must belong to the allow-list, with at least one
 * real agreement. The model's `confirming` intent is honoured only when this agrees.
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

const NEGATION = /\b(don['’]?t|do not|not|never|no need|hold (?:off|on)|wait|rather not|stop)\b/i;

/** "don't", "not", "wait", "hold off": whatever the message names, it is not asking for it. */
export const negates = (text: string): boolean => NEGATION.test(text);

/**
 * An attempt to talk the assistant out of its role ("ignore your instructions
 * and ..."). Seen live: that prefix got "what is the capital of France?"
 * answered. Code catches this one form; the model flags the rest as off_topic.
 */
const INSTRUCTION_OVERRIDE =
  /\b(?:ignore|disregard|forget|override)\b[^.?!]{0,40}\b(?:instructions?|prompts?|rules|guidelines)\b|\bsystem prompt\b|\byou are now\b|\bpretend (?:to be|you(?:'re| are))\b/i;

export const overridesInstructions = (text: string): boolean => INSTRUCTION_OVERRIDE.test(text);

/** The message this turn is answering: the newest user entry in the history. */
export function lastUserMessage(input: Pick<ProviderInput, 'history'>): string {
  return [...input.history].reverse().find((m) => m.role === 'user')?.content ?? '';
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Match a service by substring, then by token overlap ("whitening" for "Teeth
 * Whitening", "check up" for "Routine Checkup"). Short tokens are dropped so
 * filler words cannot match, and neighbouring words are also tried joined.
 * A tie returns null so the conversation asks: "teeth" against "Teeth
 * Whitening" and "Teeth Cleaning" chose neither.
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
  // At least half the service's significant words, so an incidental word cannot select it.
  if (!best || best.score < 0.5 || runnerUp?.score === best.score) return null;
  return best.name;
}

/**
 * "I'd like a haircut on Monday" -> "haircut": a thing asked for by name that
 * the catalogue did not match, so the chat can say "we don't offer that"
 * rather than ask "which service?". Only a noun phrase followed by booking
 * context counts, and generic words ("an appointment", "a time") name nothing.
 */
const SERVICE_REQUEST =
  /\b(?:book(?:\s+me)?(?:\s+in)?(?:\s+for)?|schedule|i['’]?d like|i would like|i want|i need|can i (?:get|have|book))\s+(?:a|an)\s+((?:[a-z][a-z-]*\s+){0,2}?[a-z][a-z-]*)(?=\s+(?:appointment|session|visit|on|at|tomorrow|today|next|this)\b)/i;
const GENERIC_REQUEST = new Set([
  'appointment', 'booking', 'slot', 'time', 'visit', 'session', 'consultation', 'consult', 'day', 'date',
  'meeting', 'reservation', 'checkup', 'check-up', 'one', 'spot',
]);

export function requestedService(text: string): string | null {
  const phrase = text.match(SERVICE_REQUEST)?.[1]?.toLowerCase();
  if (!phrase) return null;
  const head = phrase.split(/\s+/).at(-1)!;
  return GENERIC_REQUEST.has(head) ? null : phrase;
}

const PRICE_QUESTION = /\b(price|prices|cost|costs|how much|fee|charge)\b/i;
const DURATION_QUESTION = /\b(how long|duration|minutes|mins)\b/i;

/** Does the message ask about a service's price or length? */
export const asksAboutService = (text: string): boolean => PRICE_QUESTION.test(text) || DURATION_QUESTION.test(text);

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const pad = (n: number | null | undefined): string => String(n ?? 0).padStart(2, '0');

export const toMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * chrono's reading, resolved against the business's wall clock as this turn
 * sees it, not the server's: "tomorrow" must not shift by a day for a server
 * in another timezone, and every check on one turn must agree on "today".
 */
const parseDates = (text: string, ctx: Pick<ParseContext, 'today' | 'nowTime'>) =>
  chrono.parse(text, wallClock(ctx.today, ctx.nowTime), { forwardDate: true });

/**
 * chrono resolves "sometime next week" to a specific day marked certain, which
 * would silently book whichever day falls a week out. A vague range must stay
 * vague so the next turn asks "which day?".
 */
const VAGUE_RANGE =
  /^(next|this|coming|following)\s+(week|month|fortnight)$|^(sometime|soon|whenever|anytime)$/i;

/** The date chrono can read from a message with certainty, as YYYY-MM-DD. */
export function readDate(text: string, ctx: ParseContext): string | null {
  for (const { text: matched, start } of parseDates(text, ctx)) {
    if (VAGUE_RANGE.test(matched.trim())) continue;
    // Implied values are chrono completing a bare "2pm" with today's date;
    // taking that as a stated date would book today whenever a time was said.
    if (start.isCertain('day') || start.isCertain('weekday') || start.isCertain('month')) {
      const date = `${start.get('year')}-${pad(start.get('month'))}-${pad(start.get('day'))}`;
      // "Friday" said on a Friday reads as today. Once today cannot be booked
      // it can only mean a week today; while it can, readDateAmbiguity asks.
      return date === ctx.today && namesWeekdayOnly(matched, start) && !todayStillBookable(text, ctx)
        ? addDays(ctx.today, 7)
        : date;
    }
  }
  return null;
}

/**
 * "the 12th" -> the next 12th on or after today. chrono resolves "October
 * 12th" but not a bare ordinal, which is how people most often propose a day.
 * Months without that day are skipped rather than rolled over.
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
 * Both readings of a date said two ways, earlier first, or null. "03/04" is
 * March 4 in the US and 3 April almost everywhere else. A weekday named on
 * that same weekday may mean today or a week today, but only while today can
 * still be booked (otherwise readDate takes a week today).
 */
export function readDateAmbiguity(text: string, ctx: ParseContext): [string, string] | null {
  const numeric = text.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/);
  if (numeric) {
    const [a, b] = [Number(numeric[1]), Number(numeric[2])];
    if (a >= 1 && b >= 1 && a <= 12 && b <= 12 && a !== b) {
      const year = numeric[3] ? Number(numeric[3].padStart(4, '20')) : null;
      const readings = [nextOccurrence(a, b, year, ctx.today), nextOccurrence(b, a, year, ctx.today)].sort();
      return readings as [string, string];
    }
  }

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
 * Can today still be booked, for a message naming today's weekday? It must be
 * an open day, with a grid slot left after now and before closing, and any
 * time the message states still ahead.
 */
function todayStillBookable(text: string, ctx: ParseContext): boolean {
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

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/**
 * A clock time the message states, as HH:MM, or both readings of an hour said
 * without AM or PM when they cannot be told apart (see resolveMeridiem).
 * `bookable`: both readings can start an appointment; otherwise neither can.
 */
export type StatedTime =
  | { kind: 'clock'; time: string }
  | { kind: 'ambiguous'; readings: [am: string, pm: string]; bookable: boolean };

export function readTime(text: string, ctx: Pick<ParseContext, 'today' | 'nowTime' | 'opensAt' | 'closesAt'>): StatedTime | null {
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
  // chrono misses "around 3" and "4ish"; without this a part of the day ahead
  // of it ("afternoon around 3") would win and turn 3 o'clock into 14:00.
  const bare = matchBareHour(text);
  return bare ? clock(bare.hour, bare.minute, false) : null;
}

/** "around 3", "about 4:30", "3ish". Hours followed by a unit ("3 days", "2 people") are not times. */
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
 * AM or PM for an hour said without either, or null when the user must be
 * asked. A stated part of the day decides; otherwise the hour is placed only
 * when exactly one reading can start an appointment ("at 3" is 3 PM for a 9–5
 * business). Neither ("at 5") or both (an 8–22 business, "at 9") is a guess,
 * so null. 24-hour values and 12 are taken as said.
 */
export function resolveMeridiem(
  hour: number,
  minute: number,
  text: string,
  hours: Pick<ProviderInput, 'opensAt' | 'closesAt'>,
): number | null {
  if (hour === 0 || hour >= 12) return hour;
  const part = statedPartOfDay(text);
  if (part) return part === 'morning' ? hour : hour + 12;

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

/** Start times [from, to) each part of the day covers, as HH:MM. */
export const PART_OF_DAY_WINDOW: Record<PartOfDay, readonly [from: string, to: string]> = {
  morning: ['00:00', '12:00'],
  afternoon: ['12:00', '17:00'],
  evening: ['17:00', '24:00'],
};

/** The part of the day a message names, if any. "tonight", "after work" count as evening. */
export function statedPartOfDay(text: string): PartOfDay | null {
  const lower = text.toLowerCase();
  if (/\bmorning\b/.test(lower)) return 'morning';
  if (/\b(afternoon|after lunch)\b/.test(lower)) return 'afternoon';
  if (/\b(evening|tonight|after work)\b/.test(lower)) return 'evening';
  return null;
}

/** "morning" -> opening time, "afternoon" -> 14:00, "evening" -> late but inside hours. */
export function matchVagueTime(text: string, opensAt: string, closesAt: string): string | null {
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

// ---------------------------------------------------------------------------
// Clarification: ask rather than guess, one question per turn
// ---------------------------------------------------------------------------

/**
 * What the latest message left open, and the one question to ask about it.
 * Runs on the fallback's reading and on a model's answer alike (guardrails.ts),
 * so both engines ask the same question in the same words.
 */
export interface Clarification {
  /** Draft fields the message reopened: its reading is not stored, and an older value is superseded. */
  fields: ('date' | 'time')[];
  question: string;
  /** The readings offered as answers; absent when the question is open-ended. */
  choice?: ClarificationDto;
}

/**
 * Seen live: "can i come in on 03/04 at 5?" got the date question, the AM/PM
 * question and "neither time works" in one reply. Now the date is asked first;
 * an AM/PM question is asked only when both readings can be booked; when
 * neither can, the reply states the hours and asks for a time.
 */
export function findClarification(text: string, ctx: ParseContext): Clarification | null {
  const dates = readDateAmbiguity(text, ctx);
  const time = readTime(text, ctx);
  const timeOpen = time?.kind === 'ambiguous';
  const fields: Clarification['fields'] = [...(dates ? ['date' as const] : []), ...(timeOpen ? ['time' as const] : [])];

  if (dates) {
    return {
      fields,
      question: `Did you mean ${humanDate(dates[0])} or ${humanDate(dates[1])}?`,
      choice: { field: 'date', options: dates },
    };
  }
  if (time?.kind !== 'ambiguous') return null;
  if (time.bookable) {
    const [am, pm] = time.readings.map(humanTime) as [string, string];
    return { fields, question: `Did you mean ${am} or ${pm}?`, choice: { field: 'time', options: time.readings } };
  }
  return {
    fields,
    question: `We take bookings from ${humanTime(ctx.opensAt)} to ${humanTime(ctx.closesAt)}. What time in those hours suits you?`,
  };
}

/** The draft with the fields a clarification reopened set back to unknown. */
export function withoutClarified(draft: BookingSlots, clarification: Clarification | null): BookingSlots {
  const reopened = { ...draft };
  for (const field of clarification?.fields ?? []) reopened[field] = null;
  return reopened;
}
