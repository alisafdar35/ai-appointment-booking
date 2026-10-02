'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';

interface PasswordFieldProps extends Omit<ComponentProps<'input'>, 'type'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
}

/**
 * Password input with a show/hide toggle. Hiding is the default; revealing is
 * an explicit choice that resets whenever the field remounts, so a password is
 * never left visible by accident.
 *
 * The toggle keeps one fixed label and exposes its state with aria-pressed
 * (rather than swapping the label), which is how screen readers expect a
 * toggle button to behave.
 */
export function PasswordField({ label = 'Password', hint, error, required, className, ...inputProps }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <FormField label={label} hint={hint} error={error} required={required} className={className}>
      <div className="relative">
        <Input
          type={visible ? 'text' : 'password'}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="pr-12"
          {...inputProps}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label="Show password"
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground"
        >
          {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
        </button>
      </div>
    </FormField>
  );
}
