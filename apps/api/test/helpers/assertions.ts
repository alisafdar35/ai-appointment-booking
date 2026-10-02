import assert from 'node:assert/strict';
import type { ApiErrorBody, ErrorCode } from '@appt/shared';
import type { ApiResponse } from './apiClient.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const isUuid = (value: unknown): boolean => typeof value === 'string' && UUID.test(value);
export const isUtcIso = (value: unknown): boolean => typeof value === 'string' && UTC_ISO.test(value);

/**
 * Assert the response is the API's one error envelope with the expected status
 * and stable code, and return the error for further assertions.
 *
 * Every failing endpoint must satisfy this, so checking the whole envelope
 * (message present, request id present and equal to the X-Request-Id header)
 * is cheaper here than repeating it in each test.
 */
export function assertApiError(res: ApiResponse, status: number, code: ErrorCode): ApiErrorBody['error'] {
  assert.equal(res.status, status, `expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/, 'errors must be JSON, never an HTML page');

  const body = res.body as Partial<ApiErrorBody> | null;
  assert.ok(body && typeof body === 'object' && body.error, `no error envelope in ${JSON.stringify(res.body)}`);
  const { error } = body as ApiErrorBody;
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  assert.ok(error.requestId, 'every error carries the request id');
  assert.equal(error.requestId, res.headers.get('x-request-id'));
  return error;
}

/** Poll until `check` returns a value (or stops throwing). For work the API does after it responds. */
export async function eventually<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  { timeoutMs = 3000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const result = await check();
      if (result !== undefined && result !== false) return result;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      throw lastError instanceof Error ? lastError : new Error(`Condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
