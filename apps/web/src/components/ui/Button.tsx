import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-foreground hover:bg-accent-hover',
  secondary: 'border border-border bg-surface text-foreground shadow-card hover:bg-muted',
  ghost: 'text-foreground hover:bg-muted',
  danger: 'bg-danger text-danger-foreground hover:bg-danger-hover',
};

// md and lg meet the 44px touch target everywhere; sm is compact on desktop
// pointers and grows to 44px on touch devices (the `coarse` variant).
const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-9 gap-1.5 px-3 text-sm coarse:min-h-11',
  md: 'min-h-11 gap-2 px-4 text-sm',
  lg: 'min-h-12 gap-2 px-6 text-base',
};

const BASE =
  'inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors ' +
  'disabled:pointer-events-none disabled:opacity-50';

/** Class names for a button, for elements that are not <button> (e.g. a Next.js <Link>). */
export function buttonStyles({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
} = {}): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className);
}

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and blocks further clicks (so a form cannot be submitted twice). */
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export function Button({
  variant,
  size,
  loading = false,
  fullWidth,
  leftIcon,
  rightIcon,
  className,
  disabled,
  children,
  type = 'button', // inside a <form>, an unspecified type would submit it
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonStyles({ variant, size, fullWidth, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {/* The spinner takes the left icon's place, so the button does not change width. */}
      {loading ? <Spinner /> : leftIcon}
      {children}
      {rightIcon}
    </button>
  );
}
