import { ERROR_CODES } from '@appt/shared';
import { isApiError, errorMessage } from '@/lib/api';
import type { SendFailure } from './reducer';

/**
 * Turn whatever a send threw into something a person can act on.
 *
 * The message is chosen by error *code*, never by parsing the server's text:
 * the code is the stable contract, the wording is free to change.
 */
export function describeSendFailure(error: unknown, failedAt: number): SendFailure {
  if (!isApiError(error)) return { message: errorMessage(error), failedAt };

  switch (error.code) {
    case ERROR_CODES.RATE_LIMITED: {
      const wait = error.retryAfterSeconds;
      return {
        message: wait
          ? "You're sending messages quickly. Please wait a moment before trying again."
          : "You're sending messages quickly. Please try again shortly.",
        retryAfterSeconds: wait,
        failedAt,
      };
    }
    case ERROR_CODES.SESSION_CLOSED:
      return {
        message: 'This conversation has already booked its appointment, so this message was not sent.',
        sessionClosed: true,
        failedAt,
      };
    case 'NETWORK':
      return { message: "Couldn't reach the server. Check your connection and try again.", failedAt };
    default:
      return { message: error.message, failedAt };
  }
}
