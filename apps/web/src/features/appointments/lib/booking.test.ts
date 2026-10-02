import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { classifyBookingError, createBookingFormSchema, slotEndTime } from './booking';

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const schema = createBookingFormSchema('2026-10-02');

const issues = (input: Record<string, unknown>) => {
  const result = schema.safeParse(input);
  return result.success ? {} : Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]));
};

describe('createBookingFormSchema', () => {
  it('accepts a complete booking and defaults the source to "form"', () => {
    const parsed = schema.parse({ serviceId: SERVICE_ID, date: '2026-10-05', time: '14:00', notes: '  Bring x-rays ' });
    expect(parsed).toMatchObject({ date: '2026-10-05', time: '14:00', notes: 'Bring x-rays', source: 'form' });
  });

  it('asks for what is missing in plain words', () => {
    expect(issues({ serviceId: '', date: '', time: '', notes: '' })).toEqual({
      serviceId: 'Choose a service',
      date: 'Choose a date',
      time: 'Choose a time',
    });
  });

  it('rejects a date before today in the business zone, but allows today', () => {
    expect(issues({ serviceId: SERVICE_ID, date: '2026-10-01', time: '14:00' })).toEqual({
      date: 'Choose today or a later date',
    });
    expect(issues({ serviceId: SERVICE_ID, date: '2026-10-02', time: '14:00' })).toEqual({});
  });

  it('enforces the same notes limit as the API', () => {
    expect(Object.keys(issues({ serviceId: SERVICE_ID, date: '2026-10-05', time: '14:00', notes: 'x'.repeat(2001) }))).toEqual([
      'notes',
    ]);
  });
});

describe('slotEndTime', () => {
  it('adds the duration to the start time', () => {
    expect(slotEndTime('14:00', 30)).toBe('14:30');
    expect(slotEndTime('09:45', 30)).toBe('10:15');
    expect(slotEndTime('16:30', 90)).toBe('18:00');
  });

  it('wraps at midnight rather than producing an hour of 24 or more', () => {
    expect(slotEndTime('23:30', 60)).toBe('00:30');
  });
});

describe('classifyBookingError', () => {
  const apiError = (code: ApiError['code'], extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
    new ApiError({ status: 400, code, message: `server says ${code}`, ...extra });

  it('treats a taken slot as a prompt to pick another time', () => {
    expect(classifyBookingError(apiError('SLOT_UNAVAILABLE'))).toEqual({
      kind: 'slot-taken',
      message: 'That time was just taken. Pick another from the times above.',
    });
  });

  it('puts business-hours and past-time failures on the time field using the server wording', () => {
    expect(classifyBookingError(apiError('OUTSIDE_BUSINESS_HOURS'))).toEqual({
      kind: 'time',
      message: 'server says OUTSIDE_BUSINESS_HOURS',
    });
    expect(classifyBookingError(apiError('APPOINTMENT_IN_PAST')).kind).toBe('time');
  });

  it('routes validation failures with details to the fields, and without details to the form', () => {
    expect(classifyBookingError(apiError('VALIDATION_FAILED', { details: { notes: ['Too long'] } }))).toEqual({
      kind: 'validation',
    });
    expect(classifyBookingError(apiError('VALIDATION_FAILED')).kind).toBe('form');
  });

  it('tells a rate-limited user how long to wait when the server says', () => {
    expect(classifyBookingError(apiError('RATE_LIMITED', { retryAfterSeconds: 12 }))).toEqual({
      kind: 'form',
      message: 'Too many requests. Try again in 12 seconds.',
    });
    expect(classifyBookingError(apiError('RATE_LIMITED'))).toMatchObject({ kind: 'form' });
  });

  it('passes network failures through as a form-level message', () => {
    expect(classifyBookingError(apiError('NETWORK', { status: 0 }))).toEqual({
      kind: 'form',
      message: 'server says NETWORK',
    });
  });

  it('falls back to a generic message for anything that is not an ApiError', () => {
    expect(classifyBookingError(new TypeError('boom'))).toEqual({
      kind: 'form',
      message: 'Something went wrong. Please try again.',
    });
  });
});
