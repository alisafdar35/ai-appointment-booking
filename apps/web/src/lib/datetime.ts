/**
 * Business-timezone date and time helpers.
 *
 * Every function takes the zone explicitly. The browser's own zone is
 * deliberately never consulted: a customer travelling in Tokyo must still see
 * "2:30 PM" for an appointment at a New York clinic, because that is the clock
 * on the clinic's wall.
 *
 * Two kinds of input, two kinds of meaning:
 *   - an instant ("2026-10-05T18:00:00.000Z" or a Date) is converted into the zone;
 *   - a calendar date ("2026-10-05") has no zone to convert from, so it is
 *     formatted as-is and never shifted by a UTC offset.
 *
 * Output is built from Intl.DateTimeFormat *parts* rather than the formatted
 * string. ICU versions disagree on details (Node 20+ puts a narrow no-break
 * space before "PM"), and parts keep the output identical everywhere, including
 * in tests.
 */

export type InstantInput = string | Date;
export type DateStyle = 'short' | 'medium' | 'long';

const LOCALE = 'en-US';
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MS_PER_MINUTE = 60_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Intl.DateTimeFormat construction is expensive; one instance per (zone, options). */
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let cached = formatterCache.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(LOCALE, { timeZone, ...options });
    formatterCache.set(key, cached);
  }
  return cached;
}

function partsOf(
  value: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Partial<Record<Intl.DateTimeFormatPartTypes, string>> {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatter(timeZone, options).formatToParts(value)) parts[part.type] = part.value;
  return parts;
}

function toDate(value: InstantInput): Date {
  return typeof value === 'string' ? new Date(value) : value;
}

/** A calendar date has no instant behind it, so it is read in UTC to avoid any shift. */
function resolve(value: InstantInput, timeZone: string): { date: Date; zone: string } {
  if (typeof value === 'string' && CALENDAR_DATE.test(value)) {
    return { date: new Date(`${value}T00:00:00Z`), zone: 'UTC' };
  }
  return { date: toDate(value), zone: timeZone };
}

const DATE_STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { weekday: 'short', month: 'short', day: 'numeric' }, // Mon, Oct 5
  medium: { month: 'short', day: 'numeric', year: 'numeric' }, // Oct 5, 2026
  long: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }, // Monday, October 5, 2026
};

/** "Mon, Oct 5" | "Oct 5, 2026" | "Monday, October 5, 2026". */
export function formatDate(value: InstantInput, timeZone: string, style: DateStyle = 'medium'): string {
  const { date, zone } = resolve(value, timeZone);
  return formatter(zone, DATE_STYLES[style]).format(date);
}

/** "2:30 PM". */
export function formatTime(value: InstantInput, timeZone: string): string {
  const parts = partsOf(toDate(value), timeZone, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

/** "Mon, Oct 5 · 2:30 PM". */
export function formatDateTime(value: InstantInput, timeZone: string, style: DateStyle = 'short'): string {
  return `${formatDate(value, timeZone, style)} · ${formatTime(value, timeZone)}`;
}

/** "2:30 PM – 3:15 PM". */
export function formatTimeRange(start: InstantInput, end: InstantInput, timeZone: string): string {
  return `${formatTime(start, timeZone)} – ${formatTime(end, timeZone)}`;
}

/** "14:30" -> "2:30 PM". Slot values stay 24-hour on the wire; this is display only. */
export function to12Hour(time: string): string {
  const match = WALL_CLOCK.exec(time);
  if (!match) return time;
  const hours = Number(match[1]);
  const period = hours >= 12 ? 'PM' : 'AM';
  return `${hours % 12 || 12}:${match[2]} ${period}`;
}

/** Short zone label for captions, e.g. "EDT" or "GMT+1". */
export function formatTimeZoneName(timeZone: string, at: InstantInput = new Date()): string {
  return partsOf(toDate(at), timeZone, { timeZoneName: 'short' }).timeZoneName ?? timeZone;
}

/** The calendar date ("YYYY-MM-DD") the instant falls on in `timeZone`. */
export function dateInZone(value: InstantInput, timeZone: string): string {
  const p = partsOf(toDate(value), timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

/** Today's calendar date in the business zone: the earliest date a booking can use. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return dateInZone(now, timeZone);
}

/**
 * Add whole days to a calendar date. Pure calendar arithmetic in UTC, so it is
 * immune to DST: adding a day across a clock change is still exactly one date.
 */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (both "YYYY-MM-DD"). */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function isPast(value: InstantInput, now: Date = new Date()): boolean {
  return toDate(value).getTime() < now.getTime();
}

export function isUpcoming(value: InstantInput, now: Date = new Date()): boolean {
  return !isPast(value, now);
}

const relativeFormat = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

/**
 * Human distance to an instant: "in 25 minutes", "in 3 hours", "tomorrow",
 * "in 3 days", "2 weeks ago".
 *
 * Whole days are counted on the *business-zone calendar*, not as 24-hour spans.
 * An appointment at 11:30 PM tomorrow is "tomorrow" even when a DST change
 * makes it only 23 hours away, which is how people actually say it.
 */
export function formatRelative(value: InstantInput, timeZone: string, now: Date = new Date()): string {
  const target = toDate(value);
  const dayDelta = daysBetween(dateInZone(now, timeZone), dateInZone(target, timeZone));

  if (dayDelta === 0) {
    const minutes = Math.round((target.getTime() - now.getTime()) / MS_PER_MINUTE);
    if (Math.abs(minutes) < 1) return 'now';
    if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, 'minute');
    return relativeFormat.format(Math.round(minutes / 60), 'hour');
  }
  if (Math.abs(dayDelta) < 14) return relativeFormat.format(dayDelta, 'day');
  if (Math.abs(dayDelta) < 60) return relativeFormat.format(Math.round(dayDelta / 7), 'week');
  return relativeFormat.format(Math.round(dayDelta / 30), 'month');
}
