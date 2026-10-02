'use client';

import { createContext, useContext, useId, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) throw new Error('Tab components must be rendered inside <Tabs>');
  return context;
}

const tabId = (baseId: string, value: string) => `${baseId}-tab-${value}`;
const panelId = (baseId: string, value: string) => `${baseId}-panel-${value}`;

/** Index to focus for a navigation key, or null if the key is not one. Wraps at both ends. */
function targetIndex(key: string, current: number, last: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return current === last ? 0 : current + 1;
    case 'ArrowLeft':
      return current === 0 ? last : current - 1;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  children: ReactNode;
}

/** Controlled tabs. Compose with TabList, Tab and one TabPanel per Tab. */
export function Tabs({ value, onValueChange, className, children }: TabsProps) {
  const baseId = useId();
  return (
    <TabsContext.Provider value={{ value, onValueChange, baseId }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

/**
 * The row of tabs. Arrow keys move between tabs (wrapping), Home/End jump to
 * the ends, and moving focus also selects ("automatic activation") — tab panels
 * here are cheap, so there is no reason to make keyboard users press Enter too.
 */
export function TabList({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const { onValueChange } = useTabs();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
    const current = tabs.findIndex((tab) => tab === document.activeElement);
    if (current === -1) return;

    const target = targetIndex(event.key, current, tabs.length - 1);
    if (target === null) return;

    event.preventDefault();
    const next = tabs[target];
    if (!next?.dataset.value) return;
    next.focus();
    onValueChange(next.dataset.value);
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-border bg-muted p-1', className)}
    >
      {children}
    </div>
  );
}

export function Tab({
  value,
  disabled,
  className,
  children,
}: {
  value: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ctx = useTabs();
  const selected = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={tabId(ctx.baseId, value)}
      data-value={value}
      aria-selected={selected}
      aria-controls={panelId(ctx.baseId, value)}
      // Roving tabindex: the tab list is one Tab stop; arrow keys move within it.
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      onClick={() => ctx.onValueChange(value)}
      className={cn(
        'inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-lg px-3.5 text-sm font-medium transition-colors coarse:min-h-11',
        'disabled:pointer-events-none disabled:opacity-50',
        selected ? 'bg-surface text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * The wrapper always exists (every Tab's aria-controls resolves); its content is
 * only rendered while selected, so inactive panels cost nothing.
 */
export function TabPanel({ value, className, children }: { value: string; className?: string; children: ReactNode }) {
  const ctx = useTabs();
  const selected = ctx.value === value;
  return (
    <div
      role="tabpanel"
      id={panelId(ctx.baseId, value)}
      aria-labelledby={tabId(ctx.baseId, value)}
      hidden={!selected}
      tabIndex={0}
      className={className}
    >
      {selected ? children : null}
    </div>
  );
}
