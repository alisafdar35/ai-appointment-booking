import { cn } from '@/lib/utils';

/** Three time slots with the middle one taken: the product in one glyph. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8', className)} aria-hidden="true">
      <rect width="32" height="32" rx="9" className="fill-accent" />
      <rect x="8" y="8.5" width="16" height="4" rx="2" fill="white" opacity="0.5" />
      <rect x="8" y="14" width="16" height="4" rx="2" fill="white" />
      <rect x="8" y="19.5" width="16" height="4" rx="2" fill="white" opacity="0.5" />
    </svg>
  );
}

interface LogoProps {
  className?: string;
  /** Hide the wordmark where space is tight; the accessible name stays "Slotly". */
  showWordmark?: boolean;
}

export function Logo({ className, showWordmark = true }: LogoProps) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className={cn('text-lg font-semibold tracking-tight text-foreground', !showWordmark && 'sr-only')}>
        Slotly
      </span>
    </span>
  );
}
