import { describe, expect, it } from 'vitest';
import { calendarLeaf } from './calendar-leaf';

describe('calendarLeaf', () => {
  it('reads the month and day in the business zone', () => {
    expect(calendarLeaf('2026-10-05T18:00:00.000Z', 'America/New_York')).toEqual({ month: 'Oct', day: '5' });
  });

  it('uses the zone\'s calendar day, not the UTC one', () => {
    // 01:30 UTC on Oct 6 is still the evening of Oct 5 in New York, but already Oct 6 in London.
    expect(calendarLeaf('2026-10-06T01:30:00.000Z', 'America/New_York').day).toBe('5');
    expect(calendarLeaf('2026-10-06T01:30:00.000Z', 'Europe/London').day).toBe('6');
  });
});
