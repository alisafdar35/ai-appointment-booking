import { listAppointmentsSchema } from '@appt/shared';
import { describe, expect, it } from 'vitest';
import { makeAppointment } from '../test-support';
import { VIEW_FILTERS, canCancel, displayStatus, formatCount, summarize, LIST_LIMIT } from './appointments';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const at = (id: string, startsAt: string, status: 'confirmed' | 'cancelled' | 'pending' = 'confirmed') =>
  makeAppointment({ id, startsAt, endsAt: startsAt, status });

describe('VIEW_FILTERS', () => {
  // Read back with the API's own schema: what the server will actually filter on.
  const parsed = (view: keyof typeof VIEW_FILTERS) => listAppointmentsSchema.parse(VIEW_FILTERS[view]);

  it('asks the server for active bookings only on Upcoming, so cancelled ones cannot eat into the limit', () => {
    expect(parsed('upcoming')).toEqual({ window: 'upcoming', status: ['pending', 'confirmed'], limit: LIST_LIMIT });
  });

  it('keeps everything but cancellations on Past', () => {
    expect(parsed('past')).toEqual({
      window: 'past',
      status: ['pending', 'confirmed', 'completed', 'no_show'],
      limit: LIST_LIMIT,
    });
  });

  it('lists only cancellations on Cancelled, whenever they were for', () => {
    expect(parsed('cancelled')).toEqual({ window: 'all', status: ['cancelled'], limit: LIST_LIMIT });
  });
});

describe('summarize', () => {
  it('counts the lists and takes the head of the soonest-first upcoming list as "next"', () => {
    const summary = summarize(
      [at('a', '2026-10-06T15:00:00.000Z'), at('b', '2026-10-09T15:00:00.000Z')],
      [at('x', '2026-10-03T15:00:00.000Z', 'cancelled')],
    );
    expect(summary.upcomingCount).toBe(2);
    expect(summary.next?.id).toBe('a');
    expect(summary.cancelledCount).toBe(1);
  });

  it('has no next appointment when nothing is upcoming', () => {
    expect(summarize([], [])).toEqual({ upcomingCount: 0, next: null, cancelledCount: 0 });
  });
});

describe('canCancel', () => {
  it('allows an active booking that has not started', () => {
    expect(canCancel(at('a', '2026-10-05T15:00:00.000Z'), NOW)).toBe(true);
    expect(canCancel(at('p', '2026-10-05T15:00:00.000Z', 'pending'), NOW)).toBe(true);
  });

  it('refuses one that has started or passed', () => {
    expect(canCancel(at('a', '2026-10-02T11:59:00.000Z'), NOW)).toBe(false);
    expect(canCancel(at('a', '2026-09-01T15:00:00.000Z'), NOW)).toBe(false);
  });

  it('refuses a booking that is already in a terminal state', () => {
    expect(canCancel(at('a', '2026-10-05T15:00:00.000Z', 'cancelled'), NOW)).toBe(false);
    expect(canCancel(makeAppointment({ status: 'completed' }), NOW)).toBe(false);
    expect(canCancel(makeAppointment({ status: 'no_show' }), NOW)).toBe(false);
  });
});

describe('displayStatus', () => {
  it('shows a confirmed booking as completed once it has ended', () => {
    expect(displayStatus(makeAppointment({ endsAt: '2026-10-02T11:00:00.000Z' }), NOW)).toBe('completed');
  });

  it('keeps confirmed while it is still ahead or in progress', () => {
    expect(displayStatus(makeAppointment({ endsAt: '2026-10-02T13:00:00.000Z' }), NOW)).toBe('confirmed');
  });

  it('never rewrites statuses the clock cannot explain', () => {
    const past = { endsAt: '2020-01-01T00:00:00.000Z' };
    expect(displayStatus(makeAppointment({ ...past, status: 'cancelled' }), NOW)).toBe('cancelled');
    expect(displayStatus(makeAppointment({ ...past, status: 'no_show' }), NOW)).toBe('no_show');
    expect(displayStatus(makeAppointment({ ...past, status: 'pending' }), NOW)).toBe('pending');
  });
});

describe('formatCount', () => {
  it('marks a list that hit the page limit as incomplete', () => {
    expect(formatCount(7)).toBe('7');
    expect(formatCount(LIST_LIMIT)).toBe('100+');
  });
});
