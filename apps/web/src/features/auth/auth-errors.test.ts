import { ERROR_CODES } from '@appt/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { describeAuthError, formatRetryDelay } from './auth-errors';

const apiError = (init: Partial<ConstructorParameters<typeof ApiError>[0]> & { code: ApiError['code'] }) =>
  new ApiError({ status: 400, message: 'Server said no', ...init });

describe('formatRetryDelay', () => {
  it.each([
    [undefined, 'in a moment'],
    [0, 'in a moment'],
    [1, 'in 1 second'],
    [45, 'in 45 seconds'],
    [60, 'in 1 minute'],
    [61, 'in 2 minutes'],
    [600, 'in 10 minutes'],
  ])('formats %s as "%s"', (seconds, expected) => {
    expect(formatRetryDelay(seconds)).toBe(expected);
  });
});

describe('describeAuthError', () => {
  it('uses fixed wording for bad credentials so it never hints at which field was wrong', () => {
    const result = describeAuthError(apiError({ code: ERROR_CODES.INVALID_CREDENTIALS, status: 401 }));
    expect(result).toMatchObject({ tone: 'error', title: 'Incorrect email or password' });
  });

  it('tells the user when they can retry after a rate limit', () => {
    const result = describeAuthError(apiError({ code: ERROR_CODES.RATE_LIMITED, status: 429, retryAfterSeconds: 90 }));
    expect(result.tone).toBe('warning');
    expect(result.message).toContain('in 2 minutes');
  });

  it('reads a 15-minute login lockout in minutes, from Retry-After', () => {
    const result = describeAuthError(apiError({ code: ERROR_CODES.RATE_LIMITED, status: 429, retryAfterSeconds: 897 }));
    expect(result).toMatchObject({ tone: 'warning', title: 'Too many attempts' });
    expect(result.message).toBe('Please wait and try again in 15 minutes.');
  });

  it('explains a network failure instead of showing a raw error', () => {
    const result = describeAuthError(apiError({ code: 'NETWORK', status: 0 }));
    expect(result.title).toBe('Cannot reach Slotly');
  });

  it('passes an unexpected server message through', () => {
    const result = describeAuthError(apiError({ code: ERROR_CODES.INTERNAL, status: 500, message: 'Database is down' }));
    expect(result.message).toBe('Database is down');
  });

  it('never leaks the text of a non-API error', () => {
    const result = describeAuthError(new TypeError('x is not a function'));
    expect(result.message).toBe('Please try again in a moment.');
  });
});
