import type { AppointmentDto } from '@appt/shared';

const VISIBLE = 3;

/** The next few bookings. The list is fetched active-only and soonest first, so these are simply its head. */
export function nextAppointments(appointments: readonly AppointmentDto[] | undefined): AppointmentDto[] {
  return (appointments ?? []).slice(0, VISIBLE);
}
