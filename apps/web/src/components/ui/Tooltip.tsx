'use client';

import { cloneElement, useId, useState, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface TooltipProps {
  content: ReactNode;
  side?: 'top' | 'bottom';
  /**
   * Where the bubble lines up with its trigger. `start` keeps it inside its
   * container when the trigger sits near that container's left edge.
   */
  align?: 'center' | 'start';
  /** Extra classes for the bubble, e.g. a width so long text wraps. */
  className?: string;
  /** A single focusable element; the tooltip becomes its accessible description. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
}

/**
 * Shown on hover and keyboard focus, dismissed with Escape (WCAG 1.4.13).
 * The text stays in the DOM when hidden so aria-describedby always resolves.
 */
export function Tooltip({ content, side = 'top', align = 'center', className, children }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      {cloneElement(children, { 'aria-describedby': id })}
      <span
        id={id}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-popover transition-opacity',
          side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-0',
          open ? 'visible opacity-100' : 'invisible opacity-0',
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}
