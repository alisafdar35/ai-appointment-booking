import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type AlertTone = 'info' | 'success' | 'warning' | 'error';

const TONES: Record<AlertTone, { icon: LucideIcon; box: string; accent: string }> = {
  info: { icon: Info, box: 'border-accent-border bg-accent-subtle', accent: 'text-accent-text' },
  success: { icon: CircleCheck, box: 'border-success-border bg-success-subtle', accent: 'text-success-text' },
  warning: { icon: TriangleAlert, box: 'border-warning-border bg-warning-subtle', accent: 'text-warning-text' },
  error: { icon: CircleAlert, box: 'border-danger-border bg-danger-subtle', accent: 'text-danger-text' },
};

interface AlertProps {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
  /** A follow-up control, e.g. a "Try again" button. */
  action?: ReactNode;
  /** Renders a dismiss button. */
  onDismiss?: () => void;
  /** Defaults to "alert" for errors and warnings (interrupts) and "status" otherwise (polite). */
  role?: 'alert' | 'status';
  className?: string;
}

export function Alert({ tone = 'info', title, children, action, onDismiss, role, className }: AlertProps) {
  const { icon: Icon, box, accent } = TONES[tone];
  return (
    <div
      role={role ?? (tone === 'error' || tone === 'warning' ? 'alert' : 'status')}
      className={cn('flex gap-3 rounded-xl border p-4 text-sm text-foreground', box, className)}
    >
      <Icon className={cn('mt-0.5 size-5 shrink-0', accent)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className={cn('font-semibold', accent)}>{title}</p> : null}
        {children ? <div className="break-words">{children}</div> : null}
        {action ? <div className="pt-2">{action}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-m-1.5 inline-flex size-9 shrink-0 items-center justify-center self-start rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
