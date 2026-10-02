import { isBookingComplete, mergeSlots, type BookingSlots } from '@appt/shared';
import { answerAboutService, composeReply, offTopicPrompt } from './copy.js';
import {
  findClarification,
  isAffirmative,
  lastUserMessage,
  matchService,
  negates,
  overridesInstructions,
  readDate,
  readTime,
  withoutClarified,
} from './parse.js';
import type { ProviderInput, ProviderOutput } from './provider.js';

/**
 * Policy checks on a model answer that parsed cleanly: schema validation
 * (tools.ts) catches a malformed answer, these catch a well-formed wrong one.
 * Each rule exists because of a failure seen against the live model; the
 * table in docs/ai-integration.md#guardrails lists them with that failure.
 *
 * They lean towards replacing: a false positive costs some warmth of wording,
 * a false negative tells someone they have an appointment they do not.
 */

export type GuardrailEvent =
  | { kind: 'date_corrected'; model: string | null; deterministic: string }
  | { kind: 'time_corrected'; model: string | null; deterministic: string }
  | { kind: 'service_ungrounded'; model: string; kept: string | null }
  | { kind: 'service_filled'; deterministic: string }
  | { kind: 'clarification_asked'; fields: ('date' | 'time')[]; model: Partial<BookingSlots> }
  | { kind: 'consent_unsupported' }
  | { kind: 'off_topic'; reply: string }
  | { kind: 'reply_replaced'; reason: 'booking_claim' | 'date_mismatch' | 'time_mismatch' | 'filled_in'; reply: string };

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
/** "3pm", "3:30 p.m.", "15:30". A bare "3" is not read: it is as often a count as a time. */
const CLOCK_TIME = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\b\.?|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** Compare names by their first three letters: "Thurs", "thursday" and "Thu" are one day. */
const stem = (name: string) => name.slice(0, 3).toLowerCase();

export function applyGuardrails(
  output: ProviderOutput,
  input: ProviderInput,
): { output: ProviderOutput; events: GuardrailEvent[] } {
  const events: GuardrailEvent[] = [];
  let { slots, reply, intent } = output;
  const latest = lastUserMessage(input);

  // Off topic: the model's prose is never shown, so an answer cannot leak
  // (seen live: "ignore your instructions… capital of France?" was answered).
  // A price or length question misfiled here is still answered from the catalogue.
  if (intent === 'off_topic' || overridesInstructions(latest)) {
    events.push({ kind: 'off_topic', reply });
    const asked = input.draft.serviceName ?? matchService(latest, input.services.map((s) => s.name));
    const aside = answerAboutService(latest, asked, input.services) ?? offTopicPrompt(input.businessName);
    const next = isBookingComplete(input.draft) ? '' : ` ${composeReply(input.draft, input)}`;
    return { output: { ...output, slots: {}, intent: 'other', reply: `${aside}${next}` }, events };
  }

  const clarification = findClarification(latest, input);
  const reopened = new Set(clarification?.fields);

  // Calendar arithmetic is code's job: chrono's certain reading of the latest
  // message wins (seen live: "next Wednesday" came back as a Thursday).
  // A date or time the model left out is filled in too: the user's own
  // "Monday" or "3pm" is not context the model could know better, and leaving
  // it out would ask again (seen live: "a haircut on Monday at 11am" came back
  // without the day). A negated message ("not Monday") is not filled from.
  const date = reopened.has('date') ? null : readDate(latest, input);
  const dateCorrected =
    date !== null && slots.date !== date && (slots.date != null || (input.draft.date !== date && !negates(latest)));
  if (date && dateCorrected) {
    events.push({ kind: 'date_corrected', model: slots.date ?? null, deterministic: date });
    slots = { ...slots, date };
  }

  const time = reopened.has('time') ? null : readTime(latest, input);
  const timeCorrected =
    time?.kind === 'clock' &&
    slots.time !== time.time &&
    (slots.time != null || (input.draft.time !== time.time && !negates(latest)));
  if (time?.kind === 'clock' && timeCorrected) {
    events.push({ kind: 'time_corrected', model: slots.time ?? null, deterministic: time.time });
    slots = { ...slots, time: time.time };
  }

  // Seen live: "Routine checkup" answered with no serviceName at all. A
  // catalogue name the message spells out in full, not negated, is filled in
  // like a stated time; anything looser stays the model's call.
  const named = slots.serviceName ? null : namedService(latest, input);
  if (named && named !== input.draft.serviceName) {
    events.push({ kind: 'service_filled', deterministic: named });
    slots = { ...slots, serviceName: named };
  }

  const ungrounded = slots.serviceName && !isGroundedService(slots.serviceName, input) ? slots.serviceName : null;
  if (ungrounded) {
    events.push({ kind: 'service_ungrounded', model: ungrounded, kept: input.draft.serviceName });
    const { serviceName: _dropped, ...rest } = slots;
    slots = rest;
  }

  // Seen live: "Can you confirm the price first?" reported as `confirming`.
  // Not consent; when it asks about price or length, the catalogue answers
  // and the summary is repeated after it, as for any aside.
  if (intent === 'confirming' && (clarification || !isAffirmative(latest))) {
    events.push({ kind: 'consent_unsupported' });
    const answer = answerAboutService(latest, mergeSlots(input.draft, slots).serviceName, input.services);
    intent = answer ? 'other' : 'collecting';
    if (answer) reply = answer;
  }

  if (clarification) {
    const model = Object.fromEntries(clarification.fields.filter((f) => slots[f]).map((f) => [f, slots[f]]));
    events.push({ kind: 'clarification_asked', fields: clarification.fields, model });
    slots = Object.fromEntries(Object.entries(slots).filter(([key]) => !reopened.has(key as 'date' | 'time')));
    const draft = withoutClarified(mergeSlots(input.draft, slots), clarification);
    return {
      output: {
        ...output,
        slots,
        intent,
        reply: composeReply(draft, input, clarification),
        clarify: clarification.fields,
        ...(clarification.choice ? { clarification: clarification.choice } : {}),
      },
      events,
    };
  }

  const draft = mergeSlots(input.draft, slots);
  const filledIn = Boolean(named) || (dateCorrected && !output.slots.date) || (timeCorrected && !output.slots.time);
  if (ungrounded) {
    // The model's prose was written around a service it invented.
    return { output: { ...output, slots, intent, reply: composeReply(draft, input) }, events };
  }

  // With no date in the draft, a reply naming a calendar date is talking about
  // one nobody stored ("Friday, October 9" while the draft has no day). A reply
  // written without a detail code filled in may ask for it again ("Which day?").
  const reason = BOOKING_CLAIMS.some((p) => p.test(reply))
    ? 'booking_claim'
    : (draft.date ? mentionsOtherDate(reply, draft.date) : namesCalendarDate(reply))
      ? 'date_mismatch'
      : timeCorrected && draft.time && mentionsOtherTime(reply, draft.time)
        ? 'time_mismatch'
        : filledIn
          ? 'filled_in'
          : null;
  if (reason) {
    events.push({ kind: 'reply_replaced', reason, reply });
    reply = composeReply(draft, input);
  }

  return { output: { ...output, slots, intent, reply }, events };
}

/**
 * Did the user — not the model — bring this service into the conversation?
 *
 * A name that resolves to one catalogue entry is grounded when the draft
 * already holds it, or when a user message the model was shown names that
 * entry unambiguously by the fallback's matcher ("check up" for "Routine
 * Checkup"; "teeth" with two teeth services names neither). A name outside the
 * catalogue is grounded when the user said it, so the conversation can answer
 * "we don't offer that" rather than pretend it was never asked.
 */
export function isGroundedService(
  name: string,
  input: Pick<ProviderInput, 'services' | 'history'> & { draft: Pick<BookingSlots, 'serviceName'> },
): boolean {
  const names = input.services.map((s) => s.name);
  const lower = (text: string) => text.trim().toLowerCase();
  const service = names.find((n) => lower(n) === lower(name)) ?? matchService(name, names);
  const said = input.history.filter((m) => m.role === 'user').map((m) => m.content);

  if (input.draft.serviceName && [lower(name), service && lower(service)].includes(lower(input.draft.serviceName))) {
    return true;
  }
  if (!service) return said.some((text) => matchService(text, [name]) !== null);
  return said.some((text) => matchService(text, names) === service || lower(text).includes(lower(service)));
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

/** The one catalogue service whose full name the text contains, unless the text is a refusal. */
function namedService(text: string, input: Pick<ProviderInput, 'services'>): string | null {
  if (negates(text)) return null;
  const lower = text.toLowerCase();
  const named = input.services.filter((s) => lower.includes(s.name.toLowerCase()));
  return named.length === 1 ? named[0]!.name : null;
}

/** Does the text name a calendar date ("October 9", "9 Oct", "2026-10-09")? A bare weekday does not count. */
export function namesCalendarDate(text: string): boolean {
  return [DAY_MONTH, MONTH_DAY, ISO_DATE].some((pattern) => text.search(pattern) !== -1);
}

/** Does the text state a clock time other than `time` (HH:MM)? */
export function mentionsOtherTime(text: string, time: string): boolean {
  for (const [, h12, m12, meridiem, h24, m24] of text.matchAll(CLOCK_TIME)) {
    const stated = meridiem
      ? `${String((Number(h12) % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0)).padStart(2, '0')}:${m12 ?? '00'}`
      : `${h24!.padStart(2, '0')}:${m24}`;
    if (stated !== time) return true;
  }
  return false;
}
