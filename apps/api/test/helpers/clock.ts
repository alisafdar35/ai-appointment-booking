import { clock, todayInZone } from '../../src/lib/time.js';
import { SEED, addDays, nextWeekday } from './fixtures.js';
import { zonedTimeToUtc } from './zonedTime.js';

/**
 * A pinned "today", so a test that says "Friday" or "tomorrow" means the same
 * thing whatever day the suite runs on.
 *
 * TEST_TODAY names the weekday tests run as (default Wednesday). Every
 * date-relative test must pass on all seven:
 *
 *   for d in monday tuesday wednesday thursday friday saturday sunday; do
 *     TEST_TODAY=$d npm test -w @appt/api
 *   done
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Pinned wall-clock time of day: inside opening hours, far from midnight. */
export const REFERENCE_TIME = '10:00';

function referenceWeekday(): number {
  const name = (process.env.TEST_TODAY ?? 'wednesday').trim().toLowerCase();
  const day = WEEKDAYS.indexOf(name);
  if (day === -1) throw new Error(`TEST_TODAY must be a weekday name, got "${process.env.TEST_TODAY}"`);
  return day;
}

/**
 * The date tests treat as today: the first TEST_TODAY weekday at least a week
 * after the real date. A week ahead because the database keeps real time
 * (now() decides "in the past"), so every date a test derives from the pinned
 * day — the day before included — is still in the future there.
 */
export function referenceToday(timeZone: string = SEED.bluewave.timezone): string {
  return nextWeekday(addDays(todayInZone(timeZone, new Date()), 7), referenceWeekday());
}

/**
 * Pin the application's clock (lib/time.ts `clock`) to the reference day at
 * REFERENCE_TIME in `timeZone`, for an app served in this process. Returns the
 * pinned date. Fixtures that read today (futureDate, freshDate) follow it.
 */
export function pinToday(timeZone: string = SEED.bluewave.timezone): string {
  const today = referenceToday(timeZone);
  const instant = zonedTimeToUtc(today, REFERENCE_TIME, timeZone).getTime();
  clock.now = () => new Date(instant);
  return today;
}
