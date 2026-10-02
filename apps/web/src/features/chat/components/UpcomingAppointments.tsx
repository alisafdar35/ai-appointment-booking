import { CalendarX2 } from 'lucide-react';
import Link from 'next/link';
import type { AppointmentDto } from '@appt/shared';
import { StatusBadge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatDateTime, formatRelative } from '@/lib/datetime';
import { ROUTES } from '@/lib/routes';
import { nextAppointments } from '../lib/upcoming';

interface UpcomingAppointmentsProps {
  appointments: AppointmentDto[] | undefined;
  isPending: boolean;
  isError: boolean;
  timeZone: string;
  /**
   * Staff and owners see every customer's bookings (the API scopes the list
   * only for customers), so the card says so and names whose each one is.
   */
  businessWide: boolean;
}

export function UpcomingAppointments({ appointments, isPending, isError, timeZone, businessWide }: UpcomingAppointmentsProps) {
  const next = nextAppointments(appointments);

  return (
    <Card role="region" aria-labelledby="upcoming-title">
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-4 pt-4">
        <CardTitle id="upcoming-title">{businessWide ? 'Coming up for the business' : 'Coming up'}</CardTitle>
        <Link href={ROUTES.appointments} className="rounded text-sm font-medium text-accent-text hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardBody className="px-4 py-4">
        {isPending ? (
          <div role="status" className="space-y-3">
            <span className="sr-only">Loading appointments</span>
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">We couldn&rsquo;t load {businessWide ? 'appointments' : 'your appointments'} right now.</p>
        ) : next.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CalendarX2 className="size-4 shrink-0" aria-hidden="true" />
            Nothing booked yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {next.map((appointment) => (
              <li key={appointment.id} className="space-y-0.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-foreground">{appointment.service.name}</p>
                  <StatusBadge status={appointment.status} />
                </div>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {businessWide ? `${appointment.customer.fullName} · ` : null}
                  {formatDateTime(appointment.startsAt, timeZone)} · {formatRelative(appointment.startsAt, timeZone)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
