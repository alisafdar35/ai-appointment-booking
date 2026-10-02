'use client';

import { CircleAlert } from 'lucide-react';
import { createContext, useContext, useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Label } from './Label';

interface FormFieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FormFieldContext = createContext<FormFieldContextValue | null>(null);

interface ControlAria {
  id: string | undefined;
  'aria-invalid': true | undefined;
  'aria-required': true | undefined;
  'aria-describedby': string | undefined;
}

/**
 * What Input/Textarea/Select spread onto the native control: an id the label
 * points at, aria-invalid, and aria-describedby for the hint and error. Works
 * without a surrounding FormField too (it then only echoes what was passed in).
 */
export function useControlAria(own: {
  id?: string;
  invalid?: boolean;
  'aria-describedby'?: string;
}): ControlAria {
  const field = useContext(FormFieldContext);
  const describedBy = [own['aria-describedby'], field?.describedBy].filter(Boolean).join(' ') || undefined;
  return {
    id: own.id ?? field?.id,
    'aria-invalid': own.invalid ?? field?.invalid ? true : undefined,
    'aria-required': field?.required ? true : undefined,
    'aria-describedby': describedBy,
  };
}

interface FormFieldProps {
  label: ReactNode;
  /** Persistent help text, e.g. a format or a rule. */
  hint?: ReactNode;
  /** Validation message; pass `errors.field?.message` straight from react-hook-form. */
  error?: string;
  /** Marks the field as required for assistive tech and shows an asterisk. */
  required?: boolean;
  className?: string;
  /** One Input, Textarea or Select. */
  children: ReactNode;
}

/**
 * Label + control + hint + error as one unit, wired for accessibility:
 * the label is bound to the control, and the hint and error are announced as
 * its description. The error uses role="alert" so it is read out when it appears.
 */
export function FormField({ label, hint, error, required = false, className, children }: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <FormFieldContext.Provider value={{ id, describedBy, invalid: Boolean(error), required }}>
      <div className={cn('space-y-1.5', className)}>
        <Label htmlFor={id}>
          {label}
          {required ? (
            <span aria-hidden="true" className="ml-0.5 text-danger-text">
              *
            </span>
          ) : null}
        </Label>
        {children}
        {hint ? (
          <p id={hintId} className="text-sm text-muted-foreground">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="flex items-start gap-1.5 text-sm text-danger-text">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
        ) : null}
      </div>
    </FormFieldContext.Provider>
  );
}
