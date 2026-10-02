import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { describeSendFailure } from './failure';

describe('describeSendFailure', () => {
  it('passes the wait through for a rate limit, with friendly wording', () => {
    const failure = describeSendFailure(
      new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'Too many requests', retryAfterSeconds: 12 }),
      1000,
    );
    expect(failure).toEqual({
      message: "You're sending messages quickly. Please wait a moment before trying again.",
      retryAfterSeconds: 12,
      failedAt: 1000,
    });
  });

  it('still reads kindly when the server gave no wait', () => {
    const failure = describeSendFailure(new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'x' }), 1);
    expect(failure.message).toMatch(/shortly/);
    expect(failure.retryAfterSeconds).toBeUndefined();
  });

  it('explains an unreachable server as a connection problem', () => {
    const failure = describeSendFailure(new ApiError({ status: 0, code: 'NETWORK', message: 'x' }), 1);
    expect(failure.message).toMatch(/connection/i);
  });

  it('uses the server’s message for anything else', () => {
    const failure = describeSendFailure(new ApiError({ status: 400, code: 'VALIDATION_FAILED', message: 'Message is too long' }), 1);
    expect(failure.message).toBe('Message is too long');
  });

  it('falls back to a generic message for a non-API error', () => {
    expect(describeSendFailure(new Error('boom'), 1).message).toMatch(/something went wrong/i);
  });
});
