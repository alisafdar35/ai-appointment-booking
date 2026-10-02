'use client';

import { cn } from '@/lib/utils';
import { useRealtimeStatus, type RealtimeStatus } from '@/providers/RealtimeProvider';

const STATES: Record<RealtimeStatus, { label: string; shortLabel: string; dot: string; detail: string }> = {
  connected: {
    label: 'Live',
    shortLabel: 'Live',
    dot: 'bg-success',
    detail: 'Changes made in other tabs or devices appear here instantly.',
  },
  connecting: {
    label: 'Connecting…',
    shortLabel: '…',
    dot: 'bg-accent animate-pulse',
    detail: 'Connecting for live updates.',
  },
  degraded: {
    label: 'Live updates unavailable',
    shortLabel: 'Offline',
    dot: 'bg-warning',
    detail: 'Everything still works; the page will refresh data when you return to it. We keep retrying in the background.',
  },
};

/**
 * Honest realtime status. The socket is an enhancement, so "unavailable" is
 * information rather than an error: the pill says so and explains that the app
 * keeps working.
 */
export function RealtimeStatusPill({ className }: { className?: string }) {
  const { label, shortLabel, dot, detail } = STATES[useRealtimeStatus()];
  return (
    <span
      title={detail}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted-foreground',
        className,
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full', dot)} aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
      {/* Below sm only the short form fits; the full label stays available to assistive tech. */}
      <span className="sm:hidden" aria-hidden="true">
        {shortLabel}
      </span>
      <span className="sr-only sm:hidden">{label}</span>
    </span>
  );
}
