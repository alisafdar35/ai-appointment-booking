import { ERROR_CODES, type ErrorCode } from '@appt/shared';

/**
 * The one error type the application throws on purpose.
 *
 * Carrying the HTTP status and a stable error code on the thrown object means
 * route handlers never build responses for failure cases — they throw, and the
 * single error-handling middleware renders every failure identically. Anything
 * that is NOT an AppError is by definition unexpected, so the handler can log
 * it loudly and return a generic 500 without leaking internals.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, string[]>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, string[]>; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (options.details) this.details = options.details;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, details?: Record<string, string[]>) =>
  new AppError(400, ERROR_CODES.VALIDATION_FAILED, message, details ? { details } : {});

export const unauthenticated = (message = 'Sign in to continue') =>
  new AppError(401, ERROR_CODES.UNAUTHENTICATED, message);

export const invalidCredentials = () =>
  // Deliberately identical for "no such user" and "wrong password": telling them
  // apart turns the login endpoint into an account-enumeration oracle.
  new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, 'Email or password is incorrect');

export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, ERROR_CODES.FORBIDDEN, message);

export const notFound = (what = 'Resource') =>
  new AppError(404, ERROR_CODES.NOT_FOUND, `${what} not found`);

export const emailTaken = (message = 'An account with this email already exists') =>
  new AppError(409, ERROR_CODES.EMAIL_TAKEN, message);

export const slotUnavailable = (message = 'That time slot is already booked') =>
  new AppError(409, ERROR_CODES.SLOT_UNAVAILABLE, message);

export const customerBusy = (message = 'You already have an appointment at that time') =>
  new AppError(409, ERROR_CODES.CUSTOMER_BUSY, message);

export const outsideBusinessHours = (message: string) =>
  new AppError(422, ERROR_CODES.OUTSIDE_BUSINESS_HOURS, message);

export const appointmentInPast = () =>
  new AppError(422, ERROR_CODES.APPOINTMENT_IN_PAST, 'That time is in the past');

export const appointmentNotCancellable = (status: string) =>
  new AppError(409, ERROR_CODES.APPOINTMENT_NOT_CANCELLABLE, `This appointment is already ${status}.`);

export const idempotencyKeyReused = () =>
  new AppError(
    422,
    ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
    'This Idempotency-Key was already used for a different booking. Send a new key for new details.',
  );

export const sessionClosed = () =>
  new AppError(
    409,
    ERROR_CODES.SESSION_CLOSED,
    'This conversation has already booked its appointment. Start a new one to book again.',
  );

export const sessionSuperseded = () =>
  new AppError(401, ERROR_CODES.SESSION_SUPERSEDED, 'Your session was just refreshed in another tab');

/** Postgres error codes this application reacts to by name rather than by string match. */
export const PG_ERRORS = {
  INVALID_DATETIME_FORMAT: '22007',
  DATETIME_FIELD_OVERFLOW: '22008',
  UNIQUE_VIOLATION: '23505',
  EXCLUSION_VIOLATION: '23P01',
} as const;

export function isPgError(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

/** The constraint a Postgres error names, so one SQLSTATE can map to several rules. */
export function pgConstraint(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? (e as { constraint?: string }).constraint : undefined;
}

/**
 * The appointments EXCLUDE constraints (migrations 001 and 005). Both raise
 * 23P01, and they mean different things to the user: someone else holds the
 * slot, or the user already has a booking at that time.
 */
export const OVERLAP_CONSTRAINTS = {
  SLOT: 'appointments_no_overlap',
  CUSTOMER: 'appointments_customer_no_overlap',
} as const;

/** The unique index (migration 009) allowing one live appointment per conversation. */
export const CHAT_SESSION_BOOKING_INDEX = 'appointments_one_live_per_chat_session';
