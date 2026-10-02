import { z } from 'zod';
import { isoDateSchema, timeSchema, type BookingSlots } from '@appt/shared';

/** Mirrors the `max(500)` on the draft's notes in @appt/shared; a test keeps the two in step. */
export const NOTES_MAX_LENGTH = 500;

/**
 * The fallback form's rules, assembled from the same building blocks the API
 * validates with (`isoDateSchema`, `timeSchema`), so a value the form accepts is
 * one the server's parser accepts. Only the wording differs: an empty field
 * says "Choose a date" rather than a format hint.
 *
 * A factory because "today" is a business-timezone fact the caller supplies.
 */
export function createFallbackFormSchema(today: string) {
  return z.object({
    serviceName: z.string().min(1, 'Choose a service'),
    date: z
      .string()
      .min(1, 'Choose a date')
      .pipe(isoDateSchema)
      .refine((date) => date >= today, 'Choose today or a later date'),
    time: z.string().min(1, 'Choose a time').pipe(timeSchema),
    notes: z.string().trim().max(NOTES_MAX_LENGTH, `Keep notes under ${NOTES_MAX_LENGTH} characters`),
  });
}

export type FallbackFormValues = z.infer<ReturnType<typeof createFallbackFormSchema>>;

/** The form always holds strings; a missing slot is an empty field, not null. */
export function toFormValues(draft: BookingSlots): FallbackFormValues {
  return {
    serviceName: draft.serviceName ?? '',
    date: draft.date ?? '',
    time: draft.time ?? '',
    notes: draft.notes ?? '',
  };
}

/** Why the form is on screen. It changes what the card says, not what it does. */
export type FormReason = 'stalled' | 'requested' | 'change';

export const FORM_REASON_COPY: Record<FormReason, string> = {
  stalled:
    "I'm having trouble pinning the details down — a quick form will be faster. I've filled in what I understood so far.",
  requested: 'Prefer clicking to typing? Fill in the details and book directly. It uses the same live availability as the chat.',
  change: 'Change anything you like, then book it straight from here.',
};
