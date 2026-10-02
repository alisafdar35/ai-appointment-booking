import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ERROR_CODES, type ApiErrorBody } from '@appt/shared';
import { AppError, OVERLAP_CONSTRAINTS, PG_ERRORS, isPgError, pgConstraint } from '../lib/errors.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getRequestId } from './requestContext.js';

/**
 * Errors raised by the framework itself rather than by this application's code:
 * the body parser (malformed JSON, oversize body, unsupported charset) and the
 * router (a path parameter that is not valid percent-encoding). They arrive
 * carrying the client-error status they deserve.
 */
interface FrameworkClientError extends Error {
  status: number;
  type?: string;
}

const FRAMEWORK_ERROR_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'The request body is not valid JSON',
  'entity.too.large': 'The request body is too large',
  'encoding.unsupported': 'The request body encoding is not supported',
  'charset.unsupported': 'The request body charset is not supported',
};

function isFrameworkClientError(err: unknown): err is FrameworkClientError {
  const status = (err as { status?: unknown } | null)?.status;
  return err instanceof Error && typeof status === 'number' && status >= 400 && status < 500;
}

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiErrorBody = {
    error: {
      code: ERROR_CODES.NOT_FOUND,
      message: `Cannot ${req.method} ${req.path}`,
      requestId: getRequestId(req),
    },
  };
  res.status(404).json(body);
};

/**
 * The single place in the application that turns a failure into a response.
 *
 * Three rules it exists to enforce:
 *   1. One response shape for every error, so the client has one error path.
 *   2. Nothing unexpected reaches the client. Known failures (AppError) carry a
 *      user-safe message; anything else becomes a generic 500 while the real
 *      error and stack go to the logs. A stack trace or a Postgres constraint
 *      name in a response body is an information leak.
 *   3. Every error response carries the request id, making a user report
 *      traceable to the exact log line.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Express cannot change headers after they are flushed (e.g. mid-stream).
  if (res.headersSent) {
    logger.error({ err, reqId: getRequestId(req) }, 'Error after response started; connection destroyed');
    res.destroy();
    return;
  }

  let status = 500;
  let code: string = ERROR_CODES.INTERNAL;
  let message = 'Something went wrong on our end';
  let details: Record<string, string[]> | undefined;
  let logLevel: 'warn' | 'error' = 'error';

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
    logLevel = err.status < 500 ? 'warn' : 'error';
  } else if (err instanceof ZodError) {
    // A Zod error escaping a service (rather than the validate middleware)
    // means the server produced data that failed its own contract: a bug.
    status = 500;
    message = 'Something went wrong on our end';
    logger.error({ err: err.issues, reqId: getRequestId(req) }, 'Unhandled ZodError escaped a service');
  } else if (isFrameworkClientError(err)) {
    // Raised before any route runs, and always the client's fault. Left alone
    // they would fall through to the generic 500 below, which would be wrong
    // twice: it blames the server, and it pages someone for a typo in a request.
    status = err.status;
    // A body over the cap is not a field to correct, so it gets its own code;
    // everything else here is a malformed request.
    code = status === 413 ? ERROR_CODES.PAYLOAD_TOO_LARGE : ERROR_CODES.VALIDATION_FAILED;
    message = (err.type && FRAMEWORK_ERROR_MESSAGES[err.type]) || 'The request could not be understood';
    logLevel = 'warn';
  } else if (
    isPgError(err, PG_ERRORS.INVALID_DATETIME_FORMAT) ||
    isPgError(err, PG_ERRORS.DATETIME_FIELD_OVERFLOW)
  ) {
    // A date that passed the format check but is not a real day ("2026-02-31")
    // reaches Postgres, which refuses it. That is bad input, not a server fault.
    status = 400;
    code = ERROR_CODES.VALIDATION_FAILED;
    message = 'That date or time is not valid';
    logLevel = 'warn';
  } else if (isPgError(err, PG_ERRORS.EXCLUSION_VIOLATION)) {
    // One of the appointments EXCLUDE constraints. Reaching here means two
    // requests raced past the application-level availability check — exactly
    // the case the constraints exist to catch — so it is a normal 409, named
    // after whichever rule held.
    status = 409;
    logLevel = 'warn';
    if (pgConstraint(err) === OVERLAP_CONSTRAINTS.CUSTOMER) {
      code = ERROR_CODES.CUSTOMER_BUSY;
      message = 'You already have an appointment at that time.';
    } else {
      code = ERROR_CODES.SLOT_UNAVAILABLE;
      message = 'That time slot was just taken. Please choose another.';
    }
  } else if (isPgError(err, PG_ERRORS.UNIQUE_VIOLATION)) {
    status = 409;
    code = ERROR_CODES.CONFLICT;
    message = 'That value is already in use';
    logLevel = 'warn';
  }

  logger[logLevel](
    {
      err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
      reqId: getRequestId(req),
      status,
      code,
      path: req.path,
      method: req.method,
      userId: req.auth?.sub,
    },
    'Request failed',
  );

  const body: ApiErrorBody = {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      requestId: getRequestId(req),
    },
  };

  // Outside production, attach the real message for unexpected errors so a
  // developer is not left guessing. Never in production.
  if (!env.isProduction && status >= 500 && err instanceof Error) {
    (body.error as Record<string, unknown>).debug = err.message;
  }

  res.status(status).json(body);
};

/**
 * Express 4 does not forward a rejected promise from an async handler to the
 * error middleware — it hangs the request instead. Wrapping restores that.
 *
 * (Express 5 handles this natively; this wrapper is what makes the choice of
 * Express 4 here a safe one rather than a trap. See docs/decisions.md.)
 */
export function asyncHandler<T extends RequestHandler>(handler: T): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
