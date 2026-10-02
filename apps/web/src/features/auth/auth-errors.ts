import { ERROR_CODES } from '@appt/shared';
import { isApiError } from '@/lib/api';
import { pluralize } from '@/lib/utils';

export interface AuthFormError {
  tone: 'error' | 'warning';
  title: string;
  message: string;
}

/** "in 45 seconds", "in 3 minutes". Rounds up: telling someone to retry early just burns another attempt. */
export function formatRetryDelay(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return 'in a moment';
  if (seconds < 60) return `in ${pluralize(Math.ceil(seconds), 'second')}`;
  return `in ${pluralize(Math.ceil(seconds / 60), 'minute')}`;
}

/** The first field the server flagged, so the form can move focus there. */
export function firstServerErrorField(error: unknown): string | undefined {
  return isApiError(error) ? Object.keys(error.details ?? {})[0] : undefined;
}

/**
 * Turn whatever a sign-in or sign-up call threw into the form-level message.
 * Field-level problems (VALIDATION_FAILED details, EMAIL_TAKEN) are handled
 * next to their inputs by the forms; this covers everything else.
 *
 * Wording for INVALID_CREDENTIALS is fixed here rather than taken from the
 * server so it stays identical whether the email or the password was wrong.
 */
export function describeAuthError(error: unknown): AuthFormError {
  if (!isApiError(error)) {
    return { tone: 'error', title: 'Something went wrong', message: 'Please try again in a moment.' };
  }
  switch (error.code) {
    case ERROR_CODES.INVALID_CREDENTIALS:
      return {
        tone: 'error',
        title: 'Incorrect email or password',
        message: 'Check your details and try again.',
      };
    case ERROR_CODES.RATE_LIMITED:
      return {
        tone: 'warning',
        title: 'Too many attempts',
        message: `Please wait and try again ${formatRetryDelay(error.retryAfterSeconds)}.`,
      };
    case 'NETWORK':
      return {
        tone: 'error',
        title: 'Cannot reach Slotly',
        message: 'Check your internet connection and try again.',
      };
    default:
      return { tone: 'error', title: 'Something went wrong', message: error.message };
  }
}
