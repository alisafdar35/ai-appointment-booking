import type { AppointmentDto, BookingSlots } from '@appt/shared';
import { BookingDraftCard } from './BookingDraftCard';
import { UpcomingAppointments } from './UpcomingAppointments';

interface SideRailProps {
  draft: BookingSlots;
  completed: boolean;
  timeZone: string;
  appointments: AppointmentDto[] | undefined;
  appointmentsPending: boolean;
  appointmentsError: boolean;
  /** True for staff and owners, whose appointment list covers every customer. */
  businessWide: boolean;
}

/** The right-hand rail: the live draft above the next appointments the user can see. */
export function SideRail({
  draft,
  completed,
  timeZone,
  appointments,
  appointmentsPending,
  appointmentsError,
  businessWide,
}: SideRailProps) {
  return (
    <div className="space-y-4">
      <BookingDraftCard draft={draft} completed={completed} timeZone={timeZone} />
      <UpcomingAppointments
        appointments={appointments}
        isPending={appointmentsPending}
        isError={appointmentsError}
        timeZone={timeZone}
        businessWide={businessWide}
      />
    </div>
  );
}
