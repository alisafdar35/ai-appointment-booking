import { CalendarDays, StickyNote, User, X } from 'lucide-react';
import { useId } from 'react';
import type { AppointmentDto } from '@appt/shared';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { formatDate, formatRelative, formatTimeRange } from '@/lib/datetime';
import { cn, formatPrice } from '@/lib/utils';
import { SourceBadge } from './SourceBadge';
import { calendarLeaf } from './lib/calendar-leaf';
import { canCancel, displayStatus } from './lib/appointments';

interface AppointmentCardProps {
  appointment: AppointmentDto;
  /** Business IANA timezone: every time on the card is the clock on the business's wall. */
  timezone: string;
  now: Date;
  /** Staff and owners see whose booking it is; for a customer it is always themselves. */
  showCustomer: boolean;
  highlighted: boolean;
  onCancel: (appointment: AppointmentDto) => void;
}

export function AppointmentCard({
  appointment,
  timezone,
  now,
  showCustomer,
  highlighted,
  onCancel,
}: AppointmentCardProps) {
  const titleId = useId();
  const { service, customer } = appointment;
  const cancelled = appointment.status === 'cancelled';
  const day = formatDate(appointment.startsAt, timezone, 'short');
  const leaf = calendarLeaf(appointment.startsAt, timezone);

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        'flex flex-col gap-4 rounded-xl border bg-surface p-4 shadow-card transition-colors duration-500 sm:flex-row sm:p-5',
        highlighted ? 'animate-rise-in border-accent bg-accent-subtle ring-2 ring-accent/30' : 'border-border',
      )}
    >
      <div className="flex min-w-0 flex-1 gap-4">
        <div
          aria-hidden="true"
          className={cn(
            'flex size-14 shrink-0 flex-col items-center justify-center rounded-xl leading-none',
            cancelled ? 'bg-muted text-muted-foreground' : 'bg-accent-subtle text-accent-text',
          )}
        >
          <span className="text-[0.6875rem] font-semibold uppercase tracking-wider">{leaf.month}</span>
          <span className="mt-1 text-xl font-semibold tabular-nums">{leaf.day}</span>
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <h3 id={titleId} className={cn('text-base font-semibold text-foreground', cancelled && 'line-through decoration-muted-foreground/60')}>
              {service.name}
            </h3>
            <StatusBadge status={displayStatus(appointment, now)} />
            <SourceBadge source={appointment.source} />
          </div>

          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-foreground">
            <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium">{day}</span>
            {/* On a phone the time wraps to its own line, where a trailing dot would dangle. */}
            <span aria-hidden="true" className="text-muted-foreground max-sm:hidden">
              ·
            </span>
            <span className="tabular-nums">{formatTimeRange(appointment.startsAt, appointment.endsAt, timezone)}</span>
            {cancelled ? null : (
              <span className="text-muted-foreground">({formatRelative(appointment.startsAt, timezone, now)})</span>
            )}
          </p>

          <p className="text-sm text-muted-foreground">
            {service.durationMinutes} min · {formatPrice(service.priceCents)}
          </p>

          {showCustomer ? (
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-foreground">
              <User className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Customer: </span>
              <span className="font-medium">{customer.fullName}</span>
              <span className="break-all text-muted-foreground">{customer.email}</span>
            </p>
          ) : null}

          {appointment.notes ? (
            <p className="flex gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
              <StickyNote className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 whitespace-pre-line break-words">
                <span className="sr-only">Notes: </span>
                {appointment.notes}
              </span>
            </p>
          ) : null}

          {cancelled && appointment.cancellationReason ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Reason for cancelling: </span>
              <span className="whitespace-pre-line break-words">{appointment.cancellationReason}</span>
            </p>
          ) : null}
        </div>
      </div>

      {/* Past and cancelled bookings have nothing left to do, so there is no control to explain. */}
      {canCancel(appointment, now) ? (
        <div className="flex sm:items-start">
          <Button
            variant="secondary"
            size="sm"
            fullWidth
            leftIcon={<X className="size-4" aria-hidden="true" />}
            aria-label={`Cancel ${service.name} on ${day}`}
            onClick={() => onCancel(appointment)}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </article>
  );
}
