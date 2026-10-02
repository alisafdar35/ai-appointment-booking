import type { ReactNode } from 'react';
import type { AppointmentDto } from '@appt/shared';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatDateTime, formatRelative } from '@/lib/datetime';
import { cn } from '@/lib/utils';
import { formatCount, type AppointmentSummary } from './lib/appointments';

type TileState = 'loading' | 'failed' | 'ready';

function Tile({
  label,
  state,
  className,
  children,
}: {
  label: string;
  state: TileState;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('rounded-xl border border-border bg-surface p-4 shadow-card sm:p-5', className)}>
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-2">
        {state === 'loading' ? (
          <Skeleton className="h-8 w-24" />
        ) : state === 'failed' ? (
          // The list below explains the failure and offers the retry; the tile only stops pretending to load.
          <p className="text-3xl font-semibold text-muted-foreground">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Unavailable</span>
          </p>
        ) : (
          children
        )}
      </dd>
    </div>
  );
}

const figure = 'text-3xl font-semibold tabular-nums tracking-tight text-foreground';

interface SummaryTilesProps {
  /** Null until both underlying lists have loaded, so a tile never shows a count that is still being fetched. */
  summary: AppointmentSummary | null;
  /** One of those lists failed to load: there is nothing to wait for. */
  failed: boolean;
  timezone: string;
  now: Date;
  showCustomer: boolean;
}

function NextAppointment({
  appointment,
  timezone,
  now,
  showCustomer,
}: {
  appointment: AppointmentDto | null;
  timezone: string;
  now: Date;
  showCustomer: boolean;
}) {
  if (!appointment) return <p className="text-lg font-medium text-muted-foreground">None scheduled</p>;
  return (
    <>
      <p className="text-lg font-semibold tabular-nums leading-snug tracking-tight text-foreground">
        {formatDateTime(appointment.startsAt, timezone)}
      </p>
      <p className="mt-1 truncate text-sm text-muted-foreground">
        {[
          appointment.service.name,
          showCustomer ? appointment.customer.fullName : null,
          formatRelative(appointment.startsAt, timezone, now),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </>
  );
}

export function SummaryTiles({ summary, failed, timezone, now, showCustomer }: SummaryTilesProps) {
  const state: TileState = summary ? 'ready' : failed ? 'failed' : 'loading';
  return (
    // On a phone the two counts share a row under the next appointment: stacked
    // one per row, the tiles filled the first screen before any booking showed.
    <dl aria-label="Appointment summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
      <Tile label="Upcoming" state={state}>
        {/* Counted from a capped list, so "100+" like the tabs rather than a false exact 100. */}
        <p className={figure}>{summary ? formatCount(summary.upcomingCount) : null}</p>
      </Tile>
      <Tile label="Next appointment" state={state} className="max-sm:order-first max-sm:col-span-2">
        <NextAppointment
          appointment={summary?.next ?? null}
          timezone={timezone}
          now={now}
          showCustomer={showCustomer}
        />
      </Tile>
      <Tile label="Cancelled" state={state}>
        <p className={figure}>{summary ? formatCount(summary.cancelledCount) : null}</p>
      </Tile>
    </dl>
  );
}
