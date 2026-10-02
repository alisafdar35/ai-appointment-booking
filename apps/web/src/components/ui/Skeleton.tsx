import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** Placeholder block. Decorative: pair it with a labelled live region (see SlotPicker) when loading must be announced. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}
