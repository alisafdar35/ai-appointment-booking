import { CircleCheck, Download } from 'lucide-react';
import Link from 'next/link';
import type { AppointmentDto, BookingSlots, ServiceDto } from '@appt/shared';
import { Button, buttonStyles } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { formatDate, formatTimeRange, formatTimeZoneName, to12Hour } from '@/lib/datetime';
import { ROUTES } from '@/lib/routes';
import { formatPrice } from '@/lib/utils';

interface BookedCardProps {
  /**
   * The booked row, when the client has it: always right after booking, and
   * after a reload while it is among the upcoming appointments already loaded.
   */
  appointment: AppointmentDto | undefined;
  /** What the conversation booked. The session keeps it, so the receipt survives a reload without the row. */
  draft: BookingSlots;
  /** The catalogue entry for the draft's service, for the price when only the draft is known. */
  service: ServiceDto | undefined;
  timeZone: string;
  onAddToCalendar: (appointment: AppointmentDto) => void;
}

/**
 * The receipt for a booking made in chat.
 *
 * Built from the appointment when it is loaded, otherwise from the booked
 * draft. The draft says what was booked but not what has happened since (the
 * visit may be cancelled or over), so that version claims no status and leaves
 * it to the appointments page, and without the row there is no calendar file.
 */
export function BookedCard({ appointment, draft, service, timeZone, onAddToCalendar }: BookedCardProps) {
  const rows = appointment ? appointmentRows(appointment, timeZone) : draftRows(draft, service, timeZone);

  return (
    <section
      aria-label="Booked appointment"
      className="w-full max-w-md overflow-hidden rounded-xl border border-success-border bg-surface shadow-card"
    >
      <header className="flex items-center justify-between gap-3 border-b border-success-border bg-success-subtle px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-success-text">
          <CircleCheck className="size-4" aria-hidden="true" />
          {appointment ? <>You&rsquo;re booked</> : 'Booked in this conversation'}
        </h3>
        {appointment ? <StatusBadge status={appointment.status} /> : null}
      </header>

      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 px-4 py-4 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words font-medium tabular-nums text-foreground">{value}</dd>
          </div>
        ))}
      </dl>

      {appointment ? null : (
        <p className="px-4 pb-4 text-sm text-muted-foreground">Its current status is on your appointments page.</p>
      )}

      <div className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row">
        <Link href={ROUTES.appointments} className={buttonStyles({ className: 'sm:flex-1' })}>
          View in appointments
        </Link>
        {appointment ? (
          <Button
            variant="secondary"
            className="sm:flex-1"
            onClick={() => onAddToCalendar(appointment)}
            leftIcon={<Download className="size-4" aria-hidden="true" />}
          >
            Add to calendar
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function appointmentRows(appointment: AppointmentDto, timeZone: string): [string, string][] {
  const { service } = appointment;
  const rows: [string, string][] = [
    ['Service', service.name],
    ['Date', formatDate(appointment.startsAt, timeZone, 'long')],
    ['Time', formatTimeRange(appointment.startsAt, appointment.endsAt, timeZone)],
    ['Price', formatPrice(service.priceCents)],
  ];
  if (appointment.notes) rows.push(['Notes', appointment.notes]);
  return rows;
}

function draftRows(draft: BookingSlots, service: ServiceDto | undefined, timeZone: string): [string, string][] {
  // Named for the booking's own date, so a summer date reads EDT even when it is read in winter.
  const zoneLabel = formatTimeZoneName(timeZone, `${draft.date}T12:00:00Z`);
  const rows: [string, string][] = [
    ['Service', draft.serviceName ?? ''],
    ['Date', draft.date ? formatDate(draft.date, timeZone, 'long') : ''],
    ['Time', draft.time ? `${to12Hour(draft.time)} ${zoneLabel}` : ''],
  ];
  if (service) rows.push(['Price', formatPrice(service.priceCents)]);
  if (draft.notes) rows.push(['Notes', draft.notes]);
  return rows;
}
