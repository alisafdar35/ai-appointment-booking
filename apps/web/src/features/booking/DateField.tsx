'use client';

import type { ReactNode } from 'react';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { formatDate, todayInZone } from '@/lib/datetime';
import { useBusinessTimezone } from '@/providers/AuthProvider';

export interface DateFieldProps {
  label: string;
  /** "YYYY-MM-DD", or "" when nothing is chosen. */
  value: string;
  onChange: (date: string) => void;
  onBlur?: () => void;
  /** Business IANA timezone; defaults to the signed-in user's business. */
  timezone?: string;
  error?: string;
  /** Replaces the default hint, which spells the chosen date out ("Monday, October 5, 2026"). */
  hint?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  name?: string;
  className?: string;
}

/**
 * Native date input, constrained to "today" in the *business* timezone.
 *
 * The native control keeps the platform's own picker (best on mobile) and its
 * keyboard handling. The `min` is computed from the business zone rather than
 * `new Date()` in the browser: a customer in Tokyo booking a New York clinic
 * must not be offered a date that has already ended there.
 */
export function DateField({
  label,
  value,
  onChange,
  onBlur,
  timezone,
  error,
  hint,
  required,
  disabled,
  name,
  className,
}: DateFieldProps) {
  const businessTimezone = useBusinessTimezone();
  const zone = timezone ?? businessTimezone;

  return (
    <FormField
      label={label}
      error={error}
      required={required}
      className={className}
      hint={hint ?? (value ? formatDate(value, zone, 'long') : undefined)}
    >
      <Input
        type="date"
        name={name}
        value={value}
        min={todayInZone(zone)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    </FormField>
  );
}
