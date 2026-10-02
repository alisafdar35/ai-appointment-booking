import { mergeSlots } from '@appt/shared';
import { composeReply, lastUserMessage, readCalendar } from './fallback.js';
import type { ProviderInput, ProviderOutput } from './provider.js';

/**
 * Post-checks on a model answer that parsed cleanly.
 *
 * Schema validation (tools.ts) catches an answer that is malformed. These catch
 * one that is well-formed and wrong — both seen against the live model:
 *
 *   1. Calendar arithmetic. Asked on a Friday for "next Wednesday", the model
 *      answered 2026-10-08, a Thursday. Resolving a weekday against today's
 *      date is exactly what code is reliable at and language models are not,
 *      so when chrono confidently reads a date from the same message and the
 *      model's differs, chrono wins. Only chrono's certain readings count:
 *      "the 12th" needs the month from earlier in the conversation, which the
 *      model has and the parser does not, so there the model is not overruled.
 *
 *   2. Prose that contradicts the facts. The reply is shown verbatim while
 *      details are still being collected, so a sentence claiming the booking
 *      is done, or naming a day other than the one in the draft, would mislead
 *      the user even though the stored draft is right. Such a reply is swapped
 *      for the code-composed question, which is built from the draft and so
 *      cannot disagree with it.
 *
 * Both checks lean towards replacing: a false positive costs some warmth of
 * wording, a false negative tells someone they have an appointment they do not.
 */

export type GuardrailEvent =
  | { kind: 'date_corrected'; model: string; deterministic: string }
  | { kind: 'reply_replaced'; reason: 'booking_claim' | 'date_mismatch'; reply: string };

/**
 * A booking stated as done. The model is told it cannot book, and the
 * conversation-level code is what books, so prose saying otherwise is always wrong.
 * "Shall I book it?" and "already booked by someone else" are not matched.
 */
const BOOKING_CLAIMS = [
  /\b(i|we)(['’]ve| have)\s+(now\s+|just\s+)?(booked|scheduled|reserved|confirmed)\b/i,
  /\b(is|are|been|you['’]re|you are)\s+(now\s+|all\s+)?(booked|scheduled|reserved|confirmed)\b/i,
  /^\s*(booked|confirmed|scheduled|done)\b/i,
  /\byou['’]?re all set\b/i,
];

// Full names, and the abbreviations that are not also everyday words ("sat", "sun").
const WEEKDAY_MENTION =
  /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|mon|tues?|wed|thu|thurs?|fri)s?\b/gi;
const MONTH =
  '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\b\\.?';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const DAY_MONTH = new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}`, 'gi');
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+${DAY}\\b`, 'gi');
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** Compare names by their first three letters: "Thurs", "thursday" and "Thu" are one day. */
const stem = (name: string) => name.slice(0, 3).toLowerCase();

export function applyGuardrails(
  output: ProviderOutput,
  input: ProviderInput,
): { output: ProviderOutput; events: GuardrailEvent[] } {
  const events: GuardrailEvent[] = [];
  let { slots, reply } = output;

  const deterministic = readCalendar(lastUserMessage(input), input).date;
  if (deterministic && slots.date && slots.date !== deterministic) {
    events.push({ kind: 'date_corrected', model: slots.date, deterministic });
    slots = { ...slots, date: deterministic };
  }

  const draft = mergeSlots(input.draft, slots);
  const reason = BOOKING_CLAIMS.some((p) => p.test(reply))
    ? 'booking_claim'
    : draft.date && mentionsOtherDate(reply, draft.date)
      ? 'date_mismatch'
      : null;
  if (reason) {
    events.push({ kind: 'reply_replaced', reason, reply });
    reply = composeReply(draft, input);
  }

  return { output: { ...output, slots, reply }, events };
}

/** Does the text name a weekday or calendar date other than `date` (YYYY-MM-DD)? */
export function mentionsOtherDate(text: string, date: string): boolean {
  const [, month, day] = date.split('-').map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const otherDay = (d: string, m: string) => Number(d) !== day || MONTHS.indexOf(stem(m)) + 1 !== month;

  for (const [, name] of text.matchAll(WEEKDAY_MENTION)) {
    if (stem(name!) !== weekday) return true;
  }
  for (const [, d, m] of text.matchAll(DAY_MONTH)) {
    if (otherDay(d!, m!)) return true;
  }
  for (const [, m, d] of text.matchAll(MONTH_DAY)) {
    if (otherDay(d!, m!)) return true;
  }
  for (const [iso] of text.matchAll(ISO_DATE)) {
    if (iso !== date) return true;
  }
  return false;
}
