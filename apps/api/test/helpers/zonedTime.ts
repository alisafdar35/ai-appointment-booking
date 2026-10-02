/**
 * An independent wall-clock -> instant conversion, used as a test oracle.
 *
 * The application converts in Postgres (`($date || ' ' || $time)::timestamp AT
 * TIME ZONE business.timezone`) and has no need to do it in JS, so this lives
 * with the tests: it lets a test state the instant it expects without asking
 * the database to check itself. If the two ever disagree, a booking test fails.
 */

import { zonedParts } from '../../src/lib/time.js';

/** Offset of `timeZone` from UTC, in ms, at the given instant. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Second precision is enough; no IANA zone has a sub-second offset.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock time in `timeZone` to the UTC instant it denotes.
 *
 * Iterated twice because the offset depends on the instant we are solving for:
 * the first pass uses the offset at the naive guess, the second corrects it
 * when the guess landed on the far side of a DST transition.
 *
 * DST edge cases resolve deterministically rather than throwing: a time inside
 * a spring-forward gap (02:30 on a US transition day, which does not exist)
 * lands just after the jump, and an ambiguous fall-back time (01:30, which
 * happens twice) picks the first occurrence. Both are acceptable for booking —
 * businesses do not schedule across the transition hour — and both are
 * verified in test/time.test.ts.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  let instant = naive;
  for (let i = 0; i < 2; i += 1) {
    instant = naive - offsetMs(new Date(instant), timeZone);
  }
  return new Date(instant);
}
