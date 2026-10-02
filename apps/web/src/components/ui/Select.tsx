'use client';

import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { controlStyles } from './control';
import { useControlAria } from './FormField';

export interface SelectProps extends ComponentProps<'select'> {
  invalid?: boolean;
}

/** A native <select> (best mobile and accessibility behaviour) with the app's styling. */
export function Select({ invalid, className, id, 'aria-describedby': describedBy, children, ...props }: SelectProps) {
  const aria = useControlAria({ id, invalid, 'aria-describedby': describedBy });
  return (
    <div className="relative">
      <select
        className={controlStyles(aria['aria-invalid'] ? true : undefined, cn('appearance-none pr-10', className))}
        {...aria}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
}
