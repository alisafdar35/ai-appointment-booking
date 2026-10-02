import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zonedTimeToUtc } from '../helpers/zonedTime.js';

/**
 * Timezone conversion is the kind of logic that looks right, passes a casual
 * manual check in one timezone, and is quietly wrong for half the year. These
 * cases pin the behaviour of the test oracle that the booking tests rely on, so
 * a disagreement between it and Postgres can only mean the application is wrong.
 */
describe('zonedTimeToUtc', () => {
  const cases: [string, string, string, string, string][] = [
    ['2026-10-09', '14:00', 'America/New_York', '2026-10-09T18:00:00.000Z', 'EDT, UTC-4'],
    ['2026-01-15', '14:00', 'America/New_York', '2026-01-15T19:00:00.000Z', 'EST, UTC-5'],
    ['2026-10-09', '14:00', 'Europe/London', '2026-10-09T13:00:00.000Z', 'BST, UTC+1'],
    ['2026-12-09', '14:00', 'Europe/London', '2026-12-09T14:00:00.000Z', 'GMT, UTC+0'],
    ['2026-10-09', '14:00', 'Asia/Karachi', '2026-10-09T09:00:00.000Z', 'PKT, UTC+5'],
    ['2026-10-09', '14:00', 'Asia/Kolkata', '2026-10-09T08:30:00.000Z', 'IST, half-hour offset'],
  ];

  for (const [date, time, tz, expected, label] of cases) {
    it(`${date} ${time} in ${tz} (${label})`, () => {
      assert.equal(zonedTimeToUtc(date, time, tz).toISOString(), expected);
    });
  }

  it('resolves a spring-forward gap without throwing', () => {
    // 02:30 does not exist on this date in New York; it must still yield an instant.
    const result = zonedTimeToUtc('2026-03-08', '02:30', 'America/New_York');
    assert.ok(!Number.isNaN(result.getTime()));
    assert.equal(result.toISOString(), '2026-03-08T06:30:00.000Z');
  });

  it('resolves an ambiguous fall-back time to the first occurrence', () => {
    // 01:30 happens twice on this date in New York; we take the earlier (EDT) one.
    assert.equal(
      zonedTimeToUtc('2026-11-01', '01:30', 'America/New_York').toISOString(),
      '2026-11-01T05:30:00.000Z',
    );
  });
});
