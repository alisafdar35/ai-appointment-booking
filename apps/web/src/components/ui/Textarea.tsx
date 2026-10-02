'use client';

import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { controlStyles } from './control';
import { useControlAria } from './FormField';

export interface TextareaProps extends ComponentProps<'textarea'> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, id, 'aria-describedby': describedBy, rows = 3, ...props }: TextareaProps) {
  const aria = useControlAria({ id, invalid, 'aria-describedby': describedBy });
  return (
    <textarea
      rows={rows}
      className={controlStyles(aria['aria-invalid'] ? true : undefined, cn('py-2.5', className))}
      {...aria}
      {...props}
    />
  );
}
