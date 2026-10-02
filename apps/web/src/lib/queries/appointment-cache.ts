import type { QueryClient } from '@tanstack/react-query';
import { listAppointmentsSchema, type AppointmentDto } from '@appt/shared';
import type { AppointmentFilters } from '@/lib/api';
import { queryKeys, type AppointmentListKey } from './keys';

/**
 * Would the server include this appointment in a list fetched with `filters`?
 * The filters are read with the API's own schema, so "pending,confirmed", the
 * default window and the default limit mean exactly what they mean there, and
 * a realtime update can be placed into the right cached lists (and removed
 * from the wrong ones) without a refetch.
 */
export function appointmentMatchesFilters(
  appointment: AppointmentDto,
  filters: AppointmentFilters,
  now: Date = new Date(),
): boolean {
  const { status, window } = listAppointmentsSchema.parse(filters);
  if (status && !status.includes(appointment.status)) return false;
  const startsAt = new Date(appointment.startsAt).getTime();
  if (window === 'upcoming') return startsAt >= now.getTime();
  if (window === 'past') return startsAt < now.getTime();
  return true;
}

const soonestFirst = (a: AppointmentDto, b: AppointmentDto) => a.startsAt.localeCompare(b.startsAt);
const latestFirst = (a: AppointmentDto, b: AppointmentDto) => b.startsAt.localeCompare(a.startsAt);

/**
 * Insert or replace `appointment` in one cached list, in the order the API
 * returns it: soonest first for upcoming, most recent first otherwise. The
 * order matters beyond looks: the limit then drops the same rows the server
 * would have.
 */
export function upsertIntoList(
  list: AppointmentDto[],
  appointment: AppointmentDto,
  filters: AppointmentFilters,
  now: Date = new Date(),
): AppointmentDto[] {
  const others = list.filter((item) => item.id !== appointment.id);
  if (!appointmentMatchesFilters(appointment, filters, now)) return others;
  const { window, limit } = listAppointmentsSchema.parse(filters);
  return [...others, appointment].sort(window === 'upcoming' ? soonestFirst : latestFirst).slice(0, limit);
}

/** The cached copy of an appointment, from any list that holds it. */
export function findCachedAppointment(queryClient: QueryClient, id: string): AppointmentDto | undefined {
  return queryClient
    .getQueriesData<AppointmentDto[]>({ queryKey: queryKeys.appointments.lists() })
    .flatMap(([, list]) => list ?? [])
    .find((appointment) => appointment.id === id);
}

/** Write `appointment` into exactly the cached lists the server would put it in. */
export function placeAppointmentInCaches(queryClient: QueryClient, appointment: AppointmentDto): void {
  for (const [key, list] of queryClient.getQueriesData<AppointmentDto[]>({
    queryKey: queryKeys.appointments.lists(),
  })) {
    if (!list) continue;
    const filters = (key as unknown as AppointmentListKey)[2];
    queryClient.setQueryData(key, upsertIntoList(list, appointment, filters));
  }
}

/**
 * Fold a server-confirmed appointment into every cache that can show it: each
 * cached list, and (by invalidation) the availability grid for its service, since its slot just became taken or free.
 *
 * Idempotent by id. That matters because the socket echoes an event back to the
 * tab that caused it, so the same appointment routinely arrives twice.
 */
export function upsertAppointmentInCaches(queryClient: QueryClient, appointment: AppointmentDto): void {
  placeAppointmentInCaches(queryClient, appointment);
  void queryClient.invalidateQueries({ queryKey: queryKeys.availability.forService(appointment.service.id) });
}
