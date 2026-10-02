import { cn } from '@/lib/utils';

interface SpinnerProps {
  className?: string;
  /** Announced to screen readers. Omit when the spinner sits inside a control that already says it is busy. */
  label?: string;
}

export function Spinner({ className, label }: SpinnerProps) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex">
      <svg
        className={cn('size-4 animate-spin', className)}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
