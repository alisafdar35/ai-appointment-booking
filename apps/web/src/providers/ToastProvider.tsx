'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, type AlertTone } from '@/components/ui/Alert';

export interface ToastOptions {
  title?: string;
  tone?: AlertTone;
  /** Milliseconds before auto-dismiss; 0 keeps the toast until it is dismissed. */
  durationMs?: number;
}

interface ToastItem extends Required<Pick<ToastOptions, 'tone' | 'durationMs'>> {
  id: number;
  title?: string;
  message: string;
}

interface ToastApi {
  toast: (message: string, options?: ToastOptions) => number;
  success: (message: string, options?: Omit<ToastOptions, 'tone'>) => number;
  error: (message: string, options?: Omit<ToastOptions, 'tone'>) => number;
  info: (message: string, options?: Omit<ToastOptions, 'tone'>) => number;
  warning: (message: string, options?: Omit<ToastOptions, 'tone'>) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const MAX_VISIBLE = 4;
// Errors stay longer: they usually need reading, and often acting on.
const DEFAULT_DURATION_MS: Record<AlertTone, number> = { info: 5000, success: 5000, warning: 8000, error: 8000 };

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((message: string, options: ToastOptions = {}) => {
    const tone = options.tone ?? 'info';
    const id = nextId++;
    const item: ToastItem = {
      id,
      message,
      title: options.title,
      tone,
      durationMs: options.durationMs ?? DEFAULT_DURATION_MS[tone],
    };
    setToasts((current) => [...current, item].slice(-MAX_VISIBLE));
    return id;
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      dismiss,
      success: (message, options) => toast(message, { ...options, tone: 'success' }),
      error: (message, options) => toast(message, { ...options, tone: 'error' }),
      info: (message, options) => toast(message, { ...options, tone: 'info' }),
      warning: (message, options) => toast(message, { ...options, tone: 'warning' }),
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
       * The live region is always mounted: screen readers only announce changes
       * to a region that already exists. Errors inside it use role="alert" so
       * they interrupt; everything else is announced politely.
       */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((item) => (
          <ToastView key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  // Hovering or focusing a toast pauses its timer so it cannot vanish mid-read.
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || item.durationMs === 0) return;
    const timer = setTimeout(() => onDismiss(item.id), item.durationMs);
    return () => clearTimeout(timer);
  }, [paused, item.id, item.durationMs, onDismiss]);

  return (
    <div
      className="pointer-events-auto w-full max-w-sm animate-rise-in shadow-popover"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Alert
        tone={item.tone}
        title={item.title}
        role={item.tone === 'error' ? 'alert' : 'status'}
        onDismiss={() => onDismiss(item.id)}
        className="bg-surface"
      >
        {item.message}
      </Alert>
    </div>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
