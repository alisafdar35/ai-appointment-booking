import { z } from 'zod';

export const APPOINTMENT_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_SOURCES = ['chat', 'form', 'admin'] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];

/**
 * The sources a client may claim. 'admin' (staff booking on a customer's
 * behalf) stays in the DB enum and the DTO, but no API flow creates it yet:
 * every booking is made for the caller, so accepting 'admin' from a client
 * would only let staff record themselves as the customer of an "admin" booking.
 */
export const CLIENT_APPOINTMENT_SOURCES = ['chat', 'form'] as const;

/**
 * Booking granularity: appointments start on a 30-minute grid, whatever the
 * service length, which is what most businesses publish. The availability grid
 * and the booking check share this value, so a time the picker never offers
 * (09:07) cannot be booked by typing it, where it would block two grid slots.
 */
export const SLOT_GRID_MINUTES = 30;

/**
 * Does this YYYY-MM-DD string name a day that exists?
 *
 * `Date.parse` alone is not enough: V8 rolls "2026-02-31" over to 3 March
 * instead of rejecting it. Round-tripping through UTC and comparing the result
 * with the input catches every impossible day, leap years included.
 */
export function isRealCalendarDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}

/** Calendar date in the business's timezone, not UTC. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isRealCalendarDate, 'Not a real date');

/** 24-hour wall-clock time in the business's timezone. */
export const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

/**
 * ---------------------------------------------------------------------------
 * The booking slots.
 *
 * This is the contract at the centre of the whole feature, and there is exactly
 * one of it. It is used by:
 *   - the conversational flow, to accumulate what the user has said so far
 *   - the structured fallback form, for field validation
 *   - the LLM tool definition, which is GENERATED from this schema
 *     (see apps/api/src/modules/ai/tools.ts) rather than hand-written as a
 *     second JSON Schema that could silently drift from it
 *
 * Every field is nullable because a draft is partial by nature: the entire
 * point of a multi-turn booking conversation is that slots fill in gradually.
 * ---------------------------------------------------------------------------
 */
export const bookingSlotsSchema = z.object({
  serviceName: z.string().trim().min(1).max(120).nullable().default(null),
  date: isoDateSchema.nullable().default(null),
  time: timeSchema.nullable().default(null),
  notes: z.string().trim().max(500).nullable().default(null),
});
export type BookingSlots = z.infer<typeof bookingSlotsSchema>;

export const EMPTY_SLOTS: BookingSlots = { serviceName: null, date: null, time: null, notes: null };

/** Slots without which a booking cannot be created. `notes` is optional. */
export const REQUIRED_SLOTS = ['serviceName', 'date', 'time'] as const;
export type RequiredSlot = (typeof REQUIRED_SLOTS)[number];

export function missingSlots(slots: Partial<BookingSlots> | null | undefined): RequiredSlot[] {
  if (!slots) return [...REQUIRED_SLOTS];
  return REQUIRED_SLOTS.filter((k) => {
    const v = slots[k];
    return v === null || v === undefined || v === '';
  });
}

export function isBookingComplete(slots: Partial<BookingSlots> | null | undefined): boolean {
  return missingSlots(slots).length === 0;
}

/**
 * Merge newly extracted slots over an existing draft.
 *
 * Null/undefined in the incoming patch means "the model said nothing about this
 * field on this turn", NOT "the user cleared it". Without this rule a turn like
 * "actually make it 3pm" would wipe the service the user already chose.
 */
export function mergeSlots(
  current: Partial<BookingSlots> | null | undefined,
  patch: Partial<BookingSlots> | null | undefined,
): BookingSlots {
  const base: BookingSlots = { ...EMPTY_SLOTS, ...(current ?? {}) };
  if (!patch) return base;
  for (const key of Object.keys(EMPTY_SLOTS) as (keyof BookingSlots)[]) {
    const incoming = patch[key];
    if (incoming !== null && incoming !== undefined && incoming !== '') {
      base[key] = incoming as never;
    }
  }
  return base;
}

/** Direct (non-conversational) booking request from the structured form. */
export const createAppointmentSchema = z.object({
  serviceId: z.string().uuid('Choose a service'),
  date: isoDateSchema,
  time: timeSchema,
  notes: z.string().trim().max(2000).optional(),
  chatSessionId: z.string().uuid().optional(),
  source: z.enum(CLIENT_APPOINTMENT_SOURCES).default('form'),
});
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;

export const listAppointmentsSchema = z.object({
  /**
   * One status or a comma-separated list ("pending,confirmed"), so a view can
   * exclude cancelled bookings in the query rather than after the LIMIT.
   */
  status: z
    .string()
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(APPOINTMENT_STATUSES)).min(1, 'Name at least one status'))
    .optional(),
  /** 'upcoming' | 'past' — a convenience filter the dashboard tabs use. */
  window: z.enum(['upcoming', 'past', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListAppointmentsInput = z.infer<typeof listAppointmentsSchema>;

export const cancelAppointmentSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const availabilitySchema = z.object({
  serviceId: z.string().uuid(),
  date: isoDateSchema,
});

export interface ServiceDto {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceCents: number;
}

export interface AppointmentDto {
  id: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  startsAt: string;
  endsAt: string;
  notes: string | null;
  cancellationReason: string | null;
  chatSessionId: string | null;
  createdAt: string;
  service: ServiceDto;
  customer: { id: string; fullName: string; email: string };
}

/** A free time offered in place of one that was refused, labelled for display. */
export interface BookingSuggestion {
  date: string;
  time: string;
  label: string;
}

export interface AvailabilityDto {
  date: string;
  serviceId: string;
  durationMinutes: number;
  /** The business does not open on this weekday; `slots` is then empty. */
  closed: boolean;
  slots: { time: string; available: boolean }[];
}

/**
 * Request header that makes POST /api/appointments safe to retry.
 *
 * A client generates one key per booking attempt (a UUID is ideal) and sends
 * the same key on every retry of it. The same key with the same details
 * replays the original 201 response, marked with IDEMPOTENT_REPLAY_HEADER; the
 * same key with different details is refused with IDEMPOTENCY_KEY_REUSED.
 * Keys are scoped to the signed-in user and honoured for 24 hours.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAY_HEADER = 'Idempotent-Replayed';

/** Printable ASCII, no spaces, 1-255 characters (the database enforces the same). */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[\x21-\x7E]{1,255}$/, 'Use 1-255 printable characters with no spaces, such as a UUID');
