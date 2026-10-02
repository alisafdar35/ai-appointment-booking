/**
 * Timezone handling.
 *
 * The authoritative conversion from a business-local wall clock time to an
 * instant is done in Postgres:
 *
 *     ($date || ' ' || $time)::timestamp AT TIME ZONE business.timezone
 *
 * Postgres already ships the IANA timezone database and keeps it current, so
 * delegating there avoids both an extra dependency and the risk of the app and
 * the database disagreeing about when DST started.
 *
 * The helpers below exist for the cases that genuinely need to happen in JS:
 * telling the model what "today" is, and giving the fallback date parser a
 * correct reference point.
 */

const partsFormatter = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** The wall-clock fields a zone shows at an instant. */
export function zonedParts(instant: Date, timeZone: string) {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    // Intl renders midnight as hour 24 in some locales/engines; normalise it.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

/**
 * The instant the conversation layer treats as "now" when it works out today's
 * date and time for a business. Only tests replace it, to pin "today" to a
 * chosen weekday; booking rules never read it — "in the past" is decided by
 * the database's now(), so pinning this cannot let a past slot be booked.
 */
export const clock = { now: (): Date => new Date() };

/** Today's calendar date in a business's timezone, as YYYY-MM-DD. */
export function todayInZone(timeZone: string, now: Date = clock.now()): string {
  const p = zonedParts(now, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Current wall-clock time in a business's timezone, as HH:MM. */
export function nowTimeInZone(timeZone: string, now: Date = clock.now()): string {
  const p = zonedParts(now, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * A `Date` whose local fields are the given wall-clock date and time.
 *
 * Used only as a reference point for the natural-language date parser, which
 * resolves "tomorrow" relative to the local fields of the Date it is handed.
 * Built from the turn's own `today` and `nowTime` rather than the clock, so a
 * message is read against the same day the prompt and the guardrails use.
 */
export function wallClock(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return new Date(y, m - 1, d, hh, mm);
}

/**
 * e.g. "Friday, October 9, 2026" — for prompts and confirmation copy.
 *
 * US English, like every date the web app renders: the assistant's sentence
 * and the summary card beneath it must read as one voice.
 *
 * `date` is already a calendar date in the business's timezone, so it is
 * formatted as-is. Anchoring at noon UTC and rendering in UTC keeps the label
 * on that same day; rendering in the business zone would shift it for any zone
 * more than 12 hours ahead of UTC (Auckland in summer, Tonga, Kiribati).
 */
export function humanDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));
}

/** e.g. "Fri, Oct 9" — compact enough for a tappable suggestion or a conversation title. */
export function shortDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T12:00:00Z`));
}

/** 24h "14:00" -> "2:00 PM". */
export function humanTime(time: string): string {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const period = hh < 12 ? 'AM' : 'PM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${period}`;
}
