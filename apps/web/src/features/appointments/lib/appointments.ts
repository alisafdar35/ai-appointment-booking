import { APPOINTMENT_STATUSES, type AppointmentDto, type AppointmentStatus } from '@appt/shared';
import { statusFilter, type AppointmentFilters } from '@/lib/api';

export const APPOINTMENT_VIEWS = ['upcoming', 'past', 'cancelled'] as const;
export type AppointmentView = (typeof APPOINTMENT_VIEWS)[number];

/** The API's maximum page size. The dashboard is a short list, not a paginated report. */
export const LIST_LIMIT = 100;

/** A booking that is still going ahead: the only kind that is "upcoming", and the only kind that can be cancelled. */
const ACTIVE_STATUSES: readonly AppointmentStatus[] = ['pending', 'confirmed'];
/** A visit's history: everything that went ahead, or was meant to. */
const NOT_CANCELLED = APPOINTMENT_STATUSES.filter((status) => status !== 'cancelled');

/**
 * Each tab is one server-side query, statuses included, so the API (not the
 * browser) decides what belongs on it — and in what order: upcoming soonest
 * first, the others most recent first. Filtering cancelled bookings out here
 * instead would apply the limit first and leave a tab short.
 *
 * Module constants, so every render asks the cache for the same keys.
 */
export const VIEW_FILTERS: Record<AppointmentView, AppointmentFilters> = {
  upcoming: { window: 'upcoming', status: statusFilter(ACTIVE_STATUSES), limit: LIST_LIMIT },
  past: { window: 'past', status: statusFilter(NOT_CANCELLED), limit: LIST_LIMIT },
  cancelled: { status: statusFilter(['cancelled']), limit: LIST_LIMIT },
};

/** Only an active booking that has not started yet can be cancelled. */
export function canCancel(appointment: AppointmentDto, now: Date): boolean {
  return ACTIVE_STATUSES.includes(appointment.status) && new Date(appointment.startsAt) > now;
}

/**
 * The status to show. Nothing in the system marks a visit as finished, so a
 * confirmed booking whose end time has passed would otherwise read
 * "Confirmed" forever in the Past tab. Pending, no-show and cancelled are
 * shown as stored: they say something the clock cannot.
 */
export function displayStatus(appointment: AppointmentDto, now: Date): AppointmentStatus {
  return appointment.status === 'confirmed' && new Date(appointment.endsAt) <= now ? 'completed' : appointment.status;
}

/** "100+" when the list hit the page limit, so a tab never implies it is complete when it is not. */
export function formatCount(count: number): string {
  return count >= LIST_LIMIT ? `${LIST_LIMIT}+` : String(count);
}
