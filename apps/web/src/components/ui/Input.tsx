'use client';

import type { ComponentProps } from 'react';
import { controlStyles } from './control';
import { useControlAria } from './FormField';

export interface InputProps extends ComponentProps<'input'> {
  invalid?: boolean;
}

/** Text-like input. Inside a FormField it is labelled and described automatically. */
export function Input({ invalid, className, id, 'aria-describedby': describedBy, ...props }: InputProps) {
  const aria = useControlAria({ id, invalid, 'aria-describedby': describedBy });
  return <input className={controlStyles(aria['aria-invalid'] ? true : undefined, className)} {...aria} {...props} />;
}
