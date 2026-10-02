import { cn } from '@/lib/utils';

/** Shared look for text-entry controls (Input, Textarea, Select), so they cannot drift apart. */
export function controlStyles(invalid: boolean | undefined, className?: string): string {
  return cn(
    'block w-full rounded-lg border bg-surface px-3 text-sm text-foreground shadow-card transition-colors',
    'min-h-11 hover:border-foreground/50 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60',
    invalid ? 'border-danger' : 'border-input',
    className,
  );
}
