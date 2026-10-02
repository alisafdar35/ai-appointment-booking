import type { ReactNode } from 'react';
import type { ServiceDto } from '@appt/shared';
import { formatDate, formatTimeZoneName, to12Hour } from '@/lib/datetime';
import { formatPrice } from '@/lib/utils';
import { slotEndTime } from './lib/booking';

interface BookingSummaryProps {
  service: ServiceDto | undefined;
  /** "YYYY-MM-DD", or "" while unchosen. */
  date: string;
  /** "HH:MM" 24-hour, or "" while unchosen. */
  time: string;
  timezone: string;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

const Pending = () => <span className="font-normal text-muted-foreground">Not chosen yet</span>;

/**
 * What the user is about to book, filling in as they choose. The time is
 * shown with its zone because the clinic's clock, not the visitor's, decides
 * when they should turn up.
 */
export function BookingSummary({ service, date, time, timezone }: BookingSummaryProps) {
  const end = service && time ? to12Hour(slotEndTime(time, service.durationMinutes)) : null;
  const when = date && time && end ? `${formatDate(date, timezone, 'short')} · ${to12Hour(time)} – ${end}` : null;

  return (
    <section aria-label="Booking summary" className="rounded-xl border border-accent-border bg-accent-subtle p-4">
      <dl aria-live="polite" className="space-y-2">
        <Row label="Service">{service ? service.name : <Pending />}</Row>
        <Row label="When">{when ?? <Pending />}</Row>
        {date && time ? (
          <Row label="Time zone">
            {formatTimeZoneName(timezone, `${date}T12:00:00Z`)} ({timezone})
          </Row>
        ) : null}
        <Row label="Price">{service ? formatPrice(service.priceCents) : <Pending />}</Row>
      </dl>
    </section>
  );
}
