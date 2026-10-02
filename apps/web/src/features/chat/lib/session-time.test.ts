import { describe, expect, it } from 'vitest';
import { formatSessionTime } from './session-time';

const NOW = new Date('2026-10-02T16:00:00.000Z');
const ZONE = 'America/New_York';

describe('formatSessionTime', () => {
  it('shows a clock time for today', () => {
    expect(formatSessionTime('2026-10-02T13:33:00.000Z', ZONE, NOW)).toBe('9:33 AM');
  });

  it('says Yesterday for the previous business day', () => {
    expect(formatSessionTime('2026-10-01T20:00:00.000Z', ZONE, NOW)).toBe('Yesterday');
  });

  it('uses a short date for anything older', () => {
    expect(formatSessionTime('2026-09-28T20:00:00.000Z', ZONE, NOW)).toBe('Mon, Sep 28');
  });

  it('is empty when there is no timestamp', () => {
    expect(formatSessionTime(null, ZONE, NOW)).toBe('');
  });
});
