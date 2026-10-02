import type { RequestHandler } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { AppError } from '../lib/errors.js';
import { ERROR_CODES } from '@appt/shared';

type Source = 'body' | 'query' | 'params';

/** Flatten a ZodError into { "field.path": ["message", ...] } for the UI. */
function toDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_root';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

/**
 * Validate one part of the request against a schema, replacing it with the
 * PARSED result.
 *
 * Replacing rather than merely checking is the point: downstream handlers
 * receive coerced, defaulted, trimmed data whose type matches the schema, so
 * there is no second place where a string gets turned into a number and no way
 * for a handler to reach past validation to the raw input.
 *
 * Schemas are imported from @appt/shared, so the client-side form and the
 * server enforce the identical rule set.
 */
export function validate<S extends ZodTypeAny>(schema: S, source: Source = 'body'): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(
        new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'Some fields need attention', {
          details: toDetails(result.error),
        }),
      );
      return;
    }
    // `query` and `params` are getter-only in Express 5; assigning via
    // defineProperty keeps this helper working across both major versions.
    Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
    next();
  };
}
