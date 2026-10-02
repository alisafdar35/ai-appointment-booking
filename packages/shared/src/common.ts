/**
 * The single error envelope every failing endpoint returns. Having one shape
 * means the web client has exactly one error path to implement.
 */
export interface ApiErrorBody {
  error: {
    /** Stable, machine-readable. The UI branches on this, never on the message. */
    code: string;
    /** Human-readable, safe to show a user. */
    message: string;
    /** Field-level validation detail, keyed by dotted path. */
    details?: Record<string, string[]>;
    requestId?: string;
  };
}

export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  /** The caller already holds another live appointment overlapping this time. */
  CUSTOMER_BUSY: 'CUSTOMER_BUSY',
  OUTSIDE_BUSINESS_HOURS: 'OUTSIDE_BUSINESS_HOURS',
  APPOINTMENT_IN_PAST: 'APPOINTMENT_IN_PAST',
  /** The appointment is already cancelled or completed; there is nothing to cancel. */
  APPOINTMENT_NOT_CANCELLABLE: 'APPOINTMENT_NOT_CANCELLABLE',
  /** An Idempotency-Key was reused with different booking details. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** The conversation already produced its booking and accepts no further turns. */
  SESSION_CLOSED: 'SESSION_CLOSED',
  /**
   * Another tab refreshed the same session a moment ago. Not a security event:
   * the browser already holds the successor cookie, so the client should retry
   * once rather than sign the user out.
   */
  SESSION_SUPERSEDED: 'SESSION_SUPERSEDED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  /** The write collides with an existing unique value. Not a field error: the input was well-formed. */
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
