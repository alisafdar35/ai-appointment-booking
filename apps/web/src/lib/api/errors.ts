import { type ErrorCode } from '@appt/shared';

/**
 * Codes the server defines, plus two the client raises itself: NETWORK (no
 * response at all) and UNKNOWN (a response that was not our error envelope,
 * e.g. an HTML 502 from a proxy).
 */
export type ClientErrorCode = ErrorCode | 'NETWORK' | 'UNKNOWN';

export interface ApiErrorInit {
  status: number;
  code: ClientErrorCode;
  message: string;
  details?: Record<string, string[]>;
  requestId?: string;
  retryAfterSeconds?: number;
}

/**
 * The one error type the API client throws. UI code branches on `code`
 * (stable, machine-readable) and shows `message` (safe for users), exactly as
 * the server's error envelope intends.
 */
export class ApiError extends Error {
  /** HTTP status; 0 when no response was received (NETWORK). */
  readonly status: number;
  readonly code: ClientErrorCode;
  /** Field-level validation messages, keyed by dotted path. */
  readonly details?: Record<string, string[]>;
  /** Quote this in a support request: it identifies the exact server log line. */
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function hasErrorCode(error: unknown, code: ClientErrorCode): error is ApiError {
  return error instanceof ApiError && error.code === code;
}

/** A user-presentable message for anything a catch block can receive. */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  return error instanceof ApiError ? error.message : fallback;
}
