import { CalendarCheck } from 'lucide-react';
import type { BookingSlots, ServiceDto } from '@appt/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatDate, formatTimeZoneName, to12Hour } from '@/lib/datetime';
import { cn, formatPrice } from '@/lib/utils';

interface ConfirmationCardProps {
  draft: BookingSlots;
  /** The catalogue entry for the draft's service; absent while the catalogue loads. */
  service: ServiceDto | undefined;
  timeZone: string;
  /** False once a later message exists: the card stays as history but cannot be acted on. */
  interactive: boolean;
  onConfirm: () => void;
  onChange: () => void;
}

/**
 * The last thing a user sees before a booking is written. It is rendered from
 * the structured draft, not from the assistant's sentence, so what is shown
 * here is exactly what Confirm will book.
 */
export function ConfirmationCard({ draft, service, timeZone, interactive, onConfirm, onChange }: ConfirmationCardProps) {
  // Named for the booking's own date, so a summer date reads EDT even when it is read in winter.
  const zoneLabel = formatTimeZoneName(timeZone, draft.date ? `${draft.date}T12:00:00Z` : new Date());
  const rows: [string, string][] = [
    ['Service', draft.serviceName ?? ''],
    ['Date', draft.date ? formatDate(draft.date, timeZone, 'long') : ''],
    ['Time', draft.time ? `${to12Hour(draft.time)} ${zoneLabel}` : ''],
  ];
  if (service) {
    rows.push(['Duration', `${service.durationMinutes} minutes`], ['Price', formatPrice(service.priceCents)]);
  }
  if (draft.notes) rows.push(['Notes', draft.notes]);

  return (
    <section
      aria-label="Booking summary"
      className={cn(
        'w-full max-w-md overflow-hidden rounded-xl border bg-surface shadow-card transition-opacity',
        interactive ? 'border-accent-border' : 'border-border opacity-70',
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border bg-accent-subtle/60 px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CalendarCheck className="size-4 text-accent-text" aria-hidden="true" />
          Confirm your booking
        </h3>
        {interactive ? null : <Badge>Earlier summary</Badge>}
      </header>

      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 px-4 py-4 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words font-medium tabular-nums text-foreground">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row">
        <Button className="sm:flex-1" disabled={!interactive} onClick={onConfirm}>
          Confirm booking
        </Button>
        <Button variant="secondary" className="sm:flex-1" disabled={!interactive} onClick={onChange}>
          Change something
        </Button>
      </div>
    </section>
  );
}
