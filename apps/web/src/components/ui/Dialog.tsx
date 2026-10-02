'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SIZES = { sm: 'sm:max-w-sm', md: 'sm:max-w-md', lg: 'sm:max-w-lg' } as const;

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Action row, typically a Cancel and a primary Button. */
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  /**
   * When false, Escape, the backdrop and the close button do nothing — for a
   * request in flight that must not be abandoned half-way.
   */
  dismissible?: boolean;
}

/**
 * Modal dialog, hand-rolled rather than native <dialog> so focus handling is
 * explicit and testable in every environment:
 *   - focus moves in on open (to `[data-autofocus]`, else the first control)
 *     and returns to the trigger on close
 *   - Tab and Shift+Tab are trapped inside the panel
 *   - Escape and a backdrop click close it
 *   - the page behind does not scroll
 *   - labelled by its title (and described by `description`) for screen readers
 *
 * Mark the safest control in a destructive confirmation with `data-autofocus`
 * so Enter cannot confirm by accident.
 */
export function Dialog({ open, onOpenChange, ...rest }: DialogProps) {
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<DialogPanel onOpenChange={onOpenChange} {...rest} />, document.body);
}

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('hidden'));
}

/** Mounted only while open, so its effects *are* the open/close lifecycle. */
function DialogPanel({
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: Omit<DialogProps, 'open'>) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // The latest callbacks, without re-running the lifecycle effect on every render.
  const closeRef = useRef(() => {});
  useEffect(() => {
    closeRef.current = () => {
      if (dismissible) onOpenChange(false);
    };
  });

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { overflow, paddingRight } = document.body.style;
    // Hiding the scrollbar would shift the page sideways; pad by its width.
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;

    (panel.querySelector<HTMLElement>('[data-autofocus]') ?? focusableIn(panel)[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusableIn(panel);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!(active instanceof Node) || !panel.contains(active) || active === panel) {
        // Focus has escaped (e.g. a click on the backdrop): pull it back in.
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      opener?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center bg-slate-950/50 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[90dvh] w-full animate-rise-in flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-popover sm:rounded-xl',
          SIZES[size],
        )}
      >
        {/* Only the content scrolls: the actions stay in view however long the form gets. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <h2 id={titleId} className="pr-8 text-lg font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="mt-1.5 text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
          {children ? <div className="mt-4">{children}</div> : null}
        </div>
        {footer ? (
          <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-surface px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:flex-row sm:justify-end sm:pb-4">
            {footer}
          </div>
        ) : null}
        {/* Last in DOM order so the first Tab stop is the content, not the close icon. */}
        {dismissible ? (
          <button
            type="button"
            onClick={() => closeRef.current()}
            aria-label="Close dialog"
            className="absolute right-3 top-3 inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground coarse:size-11"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
