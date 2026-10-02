import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateInZone,
  formatDate,
  formatDateTime,
  formatRelative,
  formatTime,
  formatTimeRange,
  formatTimeZoneName,
  isPast,
  isUpcoming,
  to12Hour,
  todayInZone,
} from './datetime';

const NY = 'America/New_York';
const LONDON = 'Europe/London';

describe('to12Hour', () => {
  it.each([
    ['00:00', '12:00 AM'],
    ['09:05', '9:05 AM'],
    ['12:00', '12:00 PM'],
    ['12:30', '12:30 PM'],
    ['14:30', '2:30 PM'],
    ['23:59', '11:59 PM'],
  ])('%s -> %s', (input, expected) => {
    expect(to12Hour(input)).toBe(expected);
  });

  it('returns malformed input untouched rather than inventing a time', () => {
    expect(to12Hour('25:00')).toBe('25:00');
    expect(to12Hour('soon')).toBe('soon');
  });
});

describe('formatTime / formatDate / formatDateTime', () => {
  // 2026-10-05T18:00Z is 2:00 PM EDT in New York and 7:00 PM BST in London.
  const instant = '2026-10-05T18:00:00.000Z';

  it('renders the same instant on each business zone clock', () => {
    expect(formatTime(instant, NY)).toBe('2:00 PM');
    expect(formatTime(instant, LONDON)).toBe('7:00 PM');
  });

  it('uses a plain space before the period so output is stable across ICU versions', () => {
    expect(formatTime(instant, NY)).not.toMatch(/[  ]/);
  });

  it('supports short, medium and long date styles', () => {
    expect(formatDate(instant, NY, 'short')).toBe('Mon, Oct 5');
    expect(formatDate(instant, NY)).toBe('Oct 5, 2026');
    expect(formatDate(instant, NY, 'long')).toBe('Monday, October 5, 2026');
  });

  it('shifts the date when the zone is on the other side of midnight', () => {
    // 03:30Z on the 6th is still the evening of the 5th in New York.
    expect(formatDate('2026-10-06T03:30:00Z', NY, 'short')).toBe('Mon, Oct 5');
    expect(formatDate('2026-10-06T03:30:00Z', LONDON, 'short')).toBe('Tue, Oct 6');
  });

  it('never shifts a bare calendar date by the zone offset', () => {
    expect(formatDate('2026-10-05', 'Pacific/Auckland', 'short')).toBe('Mon, Oct 5');
    expect(formatDate('2026-10-05', 'America/Los_Angeles', 'short')).toBe('Mon, Oct 5');
  });

  it('combines date and time', () => {
    expect(formatDateTime(instant, NY)).toBe('Mon, Oct 5 · 2:00 PM');
  });

  it('formats a range', () => {
    expect(formatTimeRange(instant, '2026-10-05T18:45:00Z', NY)).toBe('2:00 PM – 2:45 PM');
  });

  it('names the zone for captions', () => {
    expect(formatTimeZoneName(NY, instant)).toBe('EDT');
    expect(formatTimeZoneName(NY, '2026-01-15T12:00:00Z')).toBe('EST');
  });
});

describe('DST boundaries (America/New_York, spring forward 2026-03-08 02:00)', () => {
  it('skips the nonexistent 2:xx hour on the wall clock', () => {
    expect(formatTime('2026-03-08T06:59:00Z', NY)).toBe('1:59 AM'); // last minute of EST
    expect(formatTime('2026-03-08T07:00:00Z', NY)).toBe('3:00 AM'); // first minute of EDT
  });

  it('keeps a 9:00 AM appointment at 9:00 AM on both sides of the change', () => {
    expect(formatTime('2026-03-07T14:00:00Z', NY)).toBe('9:00 AM'); // EST, UTC-5
    expect(formatTime('2026-03-09T13:00:00Z', NY)).toBe('9:00 AM'); // EDT, UTC-4
  });

  it('counts calendar days, not 24-hour spans, across the change', () => {
    // 23 hours apart in real time, but one calendar day apart on the wall.
    const now = new Date('2026-03-08T04:30:00Z'); // Mar 7, 11:30 PM EST
    expect(formatRelative('2026-03-09T03:30:00Z', NY, now)).toBe('tomorrow'); // Mar 8, 11:30 PM EDT
  });

  it('adds days across the change without drifting', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02'); // fall back day
  });

  it('resolves the fall-back hour that happens twice', () => {
    // 2026-11-01 01:30 occurs twice in New York: once in EDT, once in EST.
    expect(formatTime('2026-11-01T05:30:00Z', NY)).toBe('1:30 AM');
    expect(formatTime('2026-11-01T06:30:00Z', NY)).toBe('1:30 AM');
  });
});

describe('todayInZone / dateInZone', () => {
  it('reads the calendar date from the business zone, not UTC', () => {
    const lateEveningNy = new Date('2026-10-06T02:00:00Z'); // Oct 5, 10 PM in New York
    expect(todayInZone(NY, lateEveningNy)).toBe('2026-10-05');
    expect(todayInZone(LONDON, lateEveningNy)).toBe('2026-10-06');
  });

  it('works for an instant string as well as a Date', () => {
    expect(dateInZone('2026-10-06T02:00:00Z', NY)).toBe('2026-10-05');
  });
});

describe('addDays', () => {
  it('rolls over months and years, forwards and backwards', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });
});

describe('isPast / isUpcoming', () => {
  const now = new Date('2026-10-05T12:00:00Z');

  it('compares instants', () => {
    expect(isPast('2026-10-05T11:59:59Z', now)).toBe(true);
    expect(isUpcoming('2026-10-05T12:00:00Z', now)).toBe(true);
    expect(isUpcoming('2026-10-06T00:00:00Z', now)).toBe(true);
    expect(isPast('2026-10-06T00:00:00Z', now)).toBe(false);
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-10-05T16:00:00Z'); // 12:00 PM in New York

  it.each([
    ['2026-10-05T16:00:20Z', 'now'],
    ['2026-10-05T16:25:00Z', 'in 25 minutes'],
    ['2026-10-05T15:00:00Z', '1 hour ago'],
    ['2026-10-05T19:00:00Z', 'in 3 hours'],
    ['2026-10-06T14:00:00Z', 'tomorrow'],
    ['2026-10-04T14:00:00Z', 'yesterday'],
    ['2026-10-08T14:00:00Z', 'in 3 days'],
    ['2026-10-02T14:00:00Z', '3 days ago'],
    ['2026-10-26T14:00:00Z', 'in 3 weeks'],
    ['2026-12-05T14:00:00Z', 'in 2 months'],
  ])('%s -> %s', (instant, expected) => {
    expect(formatRelative(instant, NY, now)).toBe(expected);
  });
});
