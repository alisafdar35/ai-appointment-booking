import { ChevronUp, ClipboardList } from 'lucide-react';
import { missingSlots, type BookingSlots } from '@appt/shared';
import { formatDate, to12Hour } from '@/lib/datetime';

interface DraftSummaryBarProps {
  draft: BookingSlots;
  completed: boolean;
  timeZone: string;
  onOpen: () => void;
}

/**
 * The rail, collapsed for narrow screens: one line above the composer that says
 * where the booking stands, and opens the full draft and appointments on tap.
 */
export function DraftSummaryBar({ draft, completed, timeZone, onOpen }: DraftSummaryBarProps) {
  const missing = missingSlots(draft);
  const parts = [
    draft.serviceName,
    draft.date ? formatDate(draft.date, timeZone, 'short') : null,
    draft.time ? to12Hour(draft.time) : null,
  ].filter(Boolean);

  const summary = completed
    ? ['Booked', ...parts].join(' · ')
    : parts.length === 0
      ? 'No booking details yet'
      : missing.length === 0
        ? `${parts.join(' · ')} · ready to confirm`
        : parts.join(' · ');

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Booking details: ${summary}`}
      className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-border bg-muted/60 px-3 text-left text-sm transition-colors hover:bg-muted"
    >
      <ClipboardList className="size-4 shrink-0 text-accent-text" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate tabular-nums text-foreground">{summary}</span>
      {!completed && parts.length > 0 && missing.length > 0 ? (
        <span className="shrink-0 text-xs text-muted-foreground">{missing.length} to go</span>
      ) : null}
      <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}
