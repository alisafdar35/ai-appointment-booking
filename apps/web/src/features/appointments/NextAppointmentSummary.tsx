import { CalendarClock } from 'lucide-react';
import type { AppointmentDto } from '@appt/shared';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatDateTime, formatRelative } from '@/lib/datetime';

interface NextAppointmentSummaryProps {
  /** Undefined while the upcoming list loads; null when nothing is upcoming. */
  next: AppointmentDto | null | undefined;
  /** The upcoming list failed to load: there is nothing to wait for. */
  failed: boolean;
  timezone: string;
  now: Date;
  showCustomer: boolean;
}

/**
 * The one thing worth summarising above the tabs. The counts live on the tabs
 * themselves; repeating them in tiles here said everything twice.
 */
export function NextAppointmentSummary({ next, failed, timezone, now, showCustomer }: NextAppointmentSummaryProps) {
  return (
    <section
      aria-label="Next appointment"
      className="flex items-center gap-4 rounded-xl border border-border bg-surface p-4 shadow-card sm:p-5"
    >
      <span
        aria-hidden="true"
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent-text"
      >
        <CalendarClock className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-muted-foreground">Next appointment</p>
        {next ? (
          <>
            <p className="mt-0.5 text-lg font-semibold tabular-nums leading-snug tracking-tight text-foreground">
              {formatDateTime(next.startsAt, timezone)}
            </p>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {[next.service.name, showCustomer ? next.customer.fullName : null, formatRelative(next.startsAt, timezone, now)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </>
        ) : next === null ? (
          <p className="mt-0.5 text-lg font-medium text-muted-foreground">None scheduled</p>
        ) : failed ? (
          // The list below explains the failure and offers the retry; this only stops pretending to load.
          <p className="mt-0.5 text-lg font-semibold text-muted-foreground">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Unavailable</span>
          </p>
        ) : (
          <Skeleton className="mt-1.5 h-6 w-48" />
        )}
      </div>
    </section>
  );
}
