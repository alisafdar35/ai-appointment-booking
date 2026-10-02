import { describe, expect, it } from 'vitest';
import { ApiError, type ClientErrorCode } from '@/lib/api';
import { queryRetryDelay, shouldRetryQuery } from './retry';

const apiError = (status: number, code: ClientErrorCode = 'INTERNAL') =>
  new ApiError({ status, code, message: 'x' });

describe('shouldRetryQuery', () => {
  it('never retries client errors', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(shouldRetryQuery(0, apiError(status, 'VALIDATION_FAILED'))).toBe(false);
    }
  });

  it('retries network failures and server errors', () => {
    expect(shouldRetryQuery(0, apiError(0, 'NETWORK'))).toBe(true);
    expect(shouldRetryQuery(1, apiError(500))).toBe(true);
    expect(shouldRetryQuery(0, apiError(503))).toBe(true);
  });

  it('gives up after two retries', () => {
    expect(shouldRetryQuery(2, apiError(500))).toBe(false);
    expect(shouldRetryQuery(2, apiError(0, 'NETWORK'))).toBe(false);
  });

  it('does not retry errors that are not ApiErrors', () => {
    expect(shouldRetryQuery(0, new TypeError('boom'))).toBe(false);
  });
});

describe('queryRetryDelay', () => {
  it('backs off exponentially up to a cap', () => {
    expect([0, 1, 2, 3, 4, 10].map(queryRetryDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });
});
