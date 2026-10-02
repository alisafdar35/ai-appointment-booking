import type { ComponentProps } from 'react';
import type { AppointmentStatus } from '@appt/shared';
import { cn } from '@/lib/utils';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  accent: 'border-accent-border bg-accent-subtle text-accent-text',
  success: 'border-success-border bg-success-subtle text-success-text',
  warning: 'border-warning-border bg-warning-subtle text-warning-text',
  danger: 'border-danger-border bg-danger-subtle text-danger-text',
};

export interface BadgeProps extends ComponentProps<'span'> {
  tone?: BadgeTone;
}

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

const STATUS_BADGES: Record<AppointmentStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'accent' },
  no_show: { label: 'No-show', tone: 'danger' },
};

/** Human label for an appointment status ("no_show" -> "No-show"). */
export function statusLabel(status: AppointmentStatus): string {
  return STATUS_BADGES[status].label;
}

/** The one place appointment statuses map to a colour, so every list and card agrees. */
export function StatusBadge({ status, className }: { status: AppointmentStatus; className?: string }) {
  const { label, tone } = STATUS_BADGES[status];
  return (
    <Badge tone={tone} className={className}>
      {label}
    </Badge>
  );
}
