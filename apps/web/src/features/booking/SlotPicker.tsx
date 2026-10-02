'use client';

import { CalendarX2, CircleAlert } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { errorMessage } from '@/lib/api';
import { formatTimeZoneName, to12Hour } from '@/lib/datetime';
import { useAvailability } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useBusinessTimezone } from '@/providers/AuthProvider';

export interface SlotPickerProps {
  serviceId: string | null | undefined;
  /** "YYYY-MM-DD" in the business timezone. */
  date: string | null | undefined;
  /** Selected time as 24-hour "HH:MM" (the wire format), or null. */
  value: string | null;
  onChange: (time: string) => void;
  /** Business IANA timezone; defaults to the signed-in user's business. Used for the caption only. */
  timezone?: string;
  disabled?: boolean;
  /** Accessible name of the radio group. */
  label?: string;
  className?: string;
}

const GRID = 'grid grid-cols-3 gap-2 sm:grid-cols-4';

/**
 * Time-slot chooser shared by the booking form and the chat's fallback card, so
 * both surfaces show exactly the same free slots from the same endpoint.
 *
 * Semantics: a radiogroup, because exactly one time is chosen. Only one slot is
 * a Tab stop (roving tabindex); arrow keys move between *available* slots and
 * select as they go, matching native radio behaviour. Taken slots stay visible
 * but disabled — hiding them would make a busy day look like a short one.
 */
export function SlotPicker({
  serviceId,
  date,
  value,
  onChange,
  timezone,
  disabled = false,
  label = 'Available times',
  className,
}: SlotPickerProps) {
  const businessTimezone = useBusinessTimezone();
  const zone = timezone ?? businessTimezone;
  const availability = useAvailability(serviceId, date);

  if (!serviceId || !date) {
    return (
      <p className={cn('rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground', className)}>
        Choose a service and a date to see available times.
      </p>
    );
  }

  if (availability.isPending) {
    return (
      <div className={className} role="status">
        <span className="sr-only">Loading available times</span>
        <div className={GRID}>
          {Array.from({ length: 12 }, (_, index) => (
            <Skeleton key={index} className="h-11 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (availability.isError) {
    return (
      <Alert
        tone="error"
        title="We couldn't load available times"
        className={className}
        action={
          <Button size="sm" variant="secondary" loading={availability.isFetching} onClick={() => availability.refetch()}>
            Try again
          </Button>
        }
      >
        {errorMessage(availability.error)}
      </Alert>
    );
  }

  const { slots, durationMinutes } = availability.data;

  if (slots.length === 0) {
    return (
      <EmptyState
        className={className}
        icon={CalendarX2}
        title="No availability on this date"
        description="The business is closed or has no room for this service. Try another day."
      />
    );
  }

  const openTimes = slots.filter((slot) => slot.available).map((slot) => slot.time);
  // Exactly one slot is reachable by Tab: the chosen one, else the first free one.
  const tabbable = value && openTimes.includes(value) ? value : openTimes[0];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'));
    const current = radios.findIndex((radio) => radio === document.activeElement);
    if (current === -1) return;

    const last = radios.length - 1;
    let target: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        target = current === last ? 0 : current + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        target = current === 0 ? last : current - 1;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = radios[target];
    if (!next?.dataset.time) return;
    next.focus();
    onChange(next.dataset.time);
  };

  return (
    <div className={cn('space-y-3', className)}>
      <p className="text-xs text-muted-foreground">
        {durationMinutes}-minute appointment · times shown in {formatTimeZoneName(zone, `${date}T12:00:00Z`)}
      </p>

      {openTimes.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-warning-text">
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          Fully booked on this date. Try another day.
        </p>
      ) : (
        <p aria-live="polite" className="sr-only">
          {openTimes.length} of {slots.length} times available
        </p>
      )}

      <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className={GRID}>
        {slots.map((slot) => {
          const selected = slot.time === value && slot.available;
          return (
            <button
              key={slot.time}
              type="button"
              role="radio"
              aria-checked={selected}
              data-time={slot.time}
              tabIndex={slot.time === tabbable ? 0 : -1}
              disabled={disabled || !slot.available}
              onClick={() => onChange(slot.time)}
              className={cn(
                'min-h-11 rounded-lg border text-sm font-medium tabular-nums transition-colors',
                selected
                  ? 'border-accent bg-accent text-accent-foreground'
                  : slot.available
                    ? 'border-border bg-surface text-foreground hover:border-accent hover:bg-accent-subtle'
                    : 'cursor-not-allowed border-border bg-muted text-muted-foreground line-through opacity-60',
                disabled && slot.available && 'opacity-60',
              )}
            >
              {to12Hour(slot.time)}
              {slot.available ? null : <span className="sr-only"> (unavailable)</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
