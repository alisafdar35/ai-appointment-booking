import { CalendarDays, Clock, NotebookPen, Tag, type LucideIcon } from 'lucide-react';
import { missingSlots, type BookingSlots, type RequiredSlot } from '@appt/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { formatDate, to12Hour } from '@/lib/datetime';
import { cn } from '@/lib/utils';

const SLOT_LABELS: Record<RequiredSlot, string> = { serviceName: 'service', date: 'date', time: 'time' };

interface BookingDraftCardProps {
  /** The server's draft, mirrored. This component only displays it. */
  draft: BookingSlots;
  timeZone: string;
  /**
   * The conversation ended in a booking. The draft stays on show as what was
   * booked: blanked out beside a "You're booked" reply, it read as though the
   * booking had been lost.
   */
  completed: boolean;
}

interface Row {
  label: string;
  icon: LucideIcon;
  value: string | null;
  optional?: boolean;
}

/**
 * A live mirror of what the assistant has understood so far. It fills in as the
 * user talks, which is the point: nothing is hidden in the model's head, and a
 * misunderstanding is visible before it becomes a booking.
 */
export function BookingDraftCard({ draft, timeZone, completed }: BookingDraftCardProps) {
  const missing = missingSlots(draft);
  const ready = !completed && missing.length === 0;

  const rows: Row[] = [
    { label: 'Service', icon: Tag, value: draft.serviceName },
    { label: 'Date', icon: CalendarDays, value: draft.date ? formatDate(draft.date, timeZone, 'long') : null },
    { label: 'Time', icon: Clock, value: draft.time ? to12Hour(draft.time) : null },
    { label: 'Notes', icon: NotebookPen, value: draft.notes, optional: true },
  ];

  return (
    <Card aria-labelledby="draft-title" role="region">
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-4 pt-4">
        <CardTitle id="draft-title">{completed ? 'Your booking' : 'Booking draft'}</CardTitle>
        {completed ? (
          <Badge tone="success">Booked</Badge>
        ) : ready ? (
          <Badge tone="accent">Ready to confirm</Badge>
        ) : null}
      </CardHeader>
      <CardBody className="space-y-3 px-4 py-4">
        <dl className="space-y-2.5">
          {rows.map(({ label, icon: Icon, value, optional }) => (
            <div key={label} className="flex items-start gap-3">
              <span
                className={cn(
                  'mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg',
                  value ? 'bg-accent-subtle text-accent-text' : 'border border-dashed border-input text-muted-foreground',
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className={cn('break-words text-sm tabular-nums', value ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                  {value ?? (optional ? 'None' : 'Not set yet')}
                </dd>
              </div>
            </div>
          ))}
        </dl>

        <p className="border-t border-border pt-3 text-xs text-muted-foreground" aria-live="polite">
          {completed
            ? 'Booked. Start a new conversation to book another.'
            : ready
              ? 'Everything is in. Confirm it in the chat to book.'
              : `Still needed: ${missing.map((slot) => SLOT_LABELS[slot]).join(', ')}`}
        </p>
      </CardBody>
    </Card>
  );
}
