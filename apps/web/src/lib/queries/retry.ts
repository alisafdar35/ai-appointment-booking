import { ApiError } from '@/lib/api';

export const MAX_QUERY_RETRIES = 2;

/**
 * Retry only failures that can plausibly succeed on a second attempt.
 *
 * A 4xx is the server saying "this request is wrong" (validation, auth,
 * not found, rate limit): repeating it returns the same answer and, for 429,
 * makes it worse. A dropped connection or a 5xx may be a restarting server or
 * a blip, so those get two more tries. Anything that is not an ApiError is a
 * bug in our own code and retrying would just hide it.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  if (!(error instanceof ApiError)) return false;
  return error.code === 'NETWORK' || error.status >= 500;
}

/** Exponential backoff: 1s, then 2s (capped), so a recovering server is not hammered. */
export function queryRetryDelay(attemptIndex: number): number {
  return Math.min(1000 * 2 ** attemptIndex, 8000);
}
