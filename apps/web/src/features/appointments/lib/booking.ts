import { z } from 'zod';
import { createAppointmentSchema, ERROR_CODES } from '@appt/shared';
import { isApiError } from '@/lib/api';

/**
 * The form validates with the API's own schema, so the two cannot disagree.
 * The only additions are friendlier messages for an empty date or time (the
 * shared regex messages read "Use YYYY-MM-DD", which means nothing to someone
 * who has simply not picked yet) and a floor of "today in the business zone",
 * which the shared schema cannot know because it has no zone.
 */
export function createBookingFormSchema(today: string) {
  return createAppointmentSchema.extend({
    date: z
      .string()
      .min(1, 'Choose a date')
      // Refined inside the pipe: a refinement chained after it would also run on an empty string.
      .pipe(createAppointmentSchema.shape.date.refine((date) => date >= today, 'Choose today or a later date')),
    time: z.string().min(1, 'Choose a time').pipe(createAppointmentSchema.shape.time),
  });
}

type BookingFormSchema = ReturnType<typeof createBookingFormSchema>;
/** What the inputs hold while the user is typing: every field is a string. */
export type BookingFormValues = z.input<BookingFormSchema>;
/** What survives validation and is sent to the API. */
export type BookingFormData = z.output<BookingFormSchema>;

const MINUTES_PER_DAY = 24 * 60;

/** "14:00" + 30 minutes -> "14:30". Wall-clock arithmetic: bookings never span midnight. */
export function slotEndTime(time: string, durationMinutes: number): string {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  const end = (hours * 60 + minutes + durationMinutes) % MINUTES_PER_DAY;
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}

/**
 * Where a failed booking should be reported. The server's error codes are
 * stable but its sentences are written for any client; the form maps each code
 * to the control the user can actually act on.
 */
export type BookingFailure =
  /** Someone else took the slot. Clear the time and show the fresh grid. */
  | { kind: 'slot-taken'; message: string }
  /** The time itself is not bookable (closed, or already past). */
  | { kind: 'time'; message: string }
  /** Field-level details are in the error; copy them onto the matching inputs. */
  | { kind: 'validation' }
  | { kind: 'form'; message: string };

export function classifyBookingError(error: unknown): BookingFailure {
  if (!isApiError(error)) return { kind: 'form', message: 'Something went wrong. Please try again.' };

  switch (error.code) {
    case ERROR_CODES.SLOT_UNAVAILABLE:
      return { kind: 'slot-taken', message: 'That time was just taken. Pick another from the times above.' };
    case ERROR_CODES.OUTSIDE_BUSINESS_HOURS:
    case ERROR_CODES.APPOINTMENT_IN_PAST:
      return { kind: 'time', message: error.message };
    case ERROR_CODES.VALIDATION_FAILED:
      return error.details ? { kind: 'validation' } : { kind: 'form', message: error.message };
    case ERROR_CODES.RATE_LIMITED:
      return {
        kind: 'form',
        message: error.retryAfterSeconds
          ? `Too many requests. Try again in ${error.retryAfterSeconds} seconds.`
          : 'Too many requests. Wait a moment and try again.',
      };
    default:
      return { kind: 'form', message: error.message };
  }
}
