import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  humanDate,
  humanTime,
  nowTimeInZone,
  shortDate,
  todayInZone,
  wallClock,
} from '../../src/lib/time.js';

/**
 * Timezone conversion is the kind of logic that looks right, passes a casual
 * manual check in one timezone, and is quietly wrong for half the year. These
 * cases pin the behaviour that the booking flow depends on.
 */
describe('todayInZone', () => {
  it('can differ from the UTC date near midnight', () => {
    // 02:00Z is 11:00 in Tokyo: the same calendar day there as in UTC.
    const instant = new Date('2026-10-09T02:00:00Z');
    assert.equal(todayInZone('UTC', instant), '2026-10-09');
    assert.equal(todayInZone('Asia/Tokyo', instant), '2026-10-09');
    // ...and 2026-10-09T20:00Z has already rolled over in Tokyo.
    const later = new Date('2026-10-09T20:00:00Z');
    assert.equal(todayInZone('UTC', later), '2026-10-09');
    assert.equal(todayInZone('Asia/Tokyo', later), '2026-10-10');
  });
});

describe('humanTime', () => {
  it('formats 24-hour input as 12-hour', () => {
    assert.equal(humanTime('14:00'), '2:00 PM');
    assert.equal(humanTime('09:30'), '9:30 AM');
    assert.equal(humanTime('00:15'), '12:15 AM');
    assert.equal(humanTime('12:00'), '12:00 PM');
    assert.equal(humanTime('23:59'), '11:59 PM');
  });
});

describe('nowTimeInZone', () => {
  it('renders the wall clock of the zone, not of the server', () => {
    const instant = new Date('2026-10-09T18:05:00Z');
    assert.equal(nowTimeInZone('UTC', instant), '18:05');
    assert.equal(nowTimeInZone('America/New_York', instant), '14:05');
    assert.equal(nowTimeInZone('Asia/Kolkata', instant), '23:35');
  });

  it('reports midnight as 00:00 rather than 24:00', () => {
    // Some Intl implementations render the first hour of the day as "24".
    assert.equal(nowTimeInZone('UTC', new Date('2026-10-09T00:00:00Z')), '00:00');
    assert.equal(nowTimeInZone('Europe/London', new Date('2026-10-08T23:30:00Z')), '00:30');
  });

  it('follows the DST offset of the given instant', () => {
    // The same UTC instant maps to different local hours either side of the transition.
    assert.equal(nowTimeInZone('America/New_York', new Date('2026-11-01T05:30:00Z')), '01:30');
    assert.equal(nowTimeInZone('America/New_York', new Date('2026-11-01T06:30:00Z')), '01:30');
    assert.equal(nowTimeInZone('America/New_York', new Date('2026-11-01T07:30:00Z')), '02:30');
  });
});

describe('wallClock', () => {
  it('carries the given wall-clock fields as local fields', () => {
    // The chrono date parser reads local getters, so these must be the business's.
    const reference = wallClock('2026-10-10', '05:15');
    assert.equal(reference.getFullYear(), 2026);
    assert.equal(reference.getMonth(), 9);
    assert.equal(reference.getDate(), 10);
    assert.equal(reference.getHours(), 5);
    assert.equal(reference.getMinutes(), 15);
  });
});

describe('humanDate', () => {
  it('names the weekday and month in full', () => {
    // US English, matching every date the web app renders under the reply.
    assert.equal(humanDate('2026-10-09'), 'Friday, October 9, 2026');
    assert.equal(humanDate('2026-01-01'), 'Thursday, January 1, 2026');
  });

  it('labels the calendar date it was given, whatever zone the business is in', () => {
    // Regression: the label used to be rendered in the business timezone, which
    // pushed "October 9" to "October 10" for zones more than 12h ahead of UTC.
    assert.equal(humanDate('2026-10-09'), 'Friday, October 9, 2026');
    assert.equal(humanDate('2026-12-31'), 'Thursday, December 31, 2026');
  });
});

describe('shortDate', () => {
  it('names the weekday, day and month compactly', () => {
    assert.equal(shortDate('2026-10-09'), 'Fri, Oct 9');
    assert.equal(shortDate('2027-01-01'), 'Fri, Jan 1');
    assert.equal(shortDate('2026-12-31'), 'Thu, Dec 31');
  });
});
