import type { ReactNode } from 'react';
import { CalendarClock, CircleCheck, MapPin, SendHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { LogoMark } from '@/components/ui/Logo';
import { cn } from '@/lib/utils';

function Message({ from, children }: { from: 'user' | 'assistant'; children: ReactNode }) {
  const mine = from === 'user';
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
          mine ? 'rounded-br-md bg-accent text-accent-foreground' : 'rounded-bl-md bg-muted text-foreground',
        )}
      >
        <span className="sr-only">{mine ? 'Customer: ' : 'Assistant: '}</span>
        {children}
      </div>
    </div>
  );
}

function SlotChip({ children, selected = false }: { children: string; selected?: boolean }) {
  return (
    <span
      className={cn(
        'rounded-lg border px-3 py-1.5 text-sm font-medium tabular-nums',
        selected
          ? 'border-accent bg-accent text-accent-foreground'
          : 'border-border bg-surface text-foreground',
      )}
    >
      {children}
    </span>
  );
}

/**
 * A static picture of the product's core exchange: ask, choose a slot,
 * confirm. It is pure markup with invented example data and no behaviour (the
 * chips are spans, not buttons, so nothing here pretends to be interactive),
 * and the caption says so.
 */
export function ChatPreview({ className }: { className?: string }) {
  return (
    <figure className={cn('w-full', className)}>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-popover">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <LogoMark className="size-8" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight">Slotly Assistant</p>
            <p className="truncate text-xs text-muted-foreground">Bluewave Dental</p>
          </div>
          <Badge tone="success">
            <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
            Online
          </Badge>
        </div>

        <div className="space-y-3 px-4 py-5">
          <Message from="user">Hi, I need a routine checkup on Monday afternoon.</Message>
          <Message from="assistant">
            <p>Happy to help. A Routine Checkup takes 30 minutes. These times are open on Monday, Oct 5:</p>
            <div role="group" aria-label="Open times" className="mt-3 flex flex-wrap gap-2">
              <SlotChip>1:00 PM</SlotChip>
              <SlotChip selected>2:30 PM</SlotChip>
              <SlotChip>3:30 PM</SlotChip>
            </div>
          </Message>
          <Message from="user">2:30 works for me.</Message>
          <Message from="assistant">
            <p className="flex items-center gap-1.5 font-medium">
              <CircleCheck className="size-4 text-success-text" aria-hidden="true" />
              You are booked.
            </p>
            <div className="mt-3 space-y-2 rounded-xl border border-border bg-surface p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold">Routine Checkup</p>
                <Badge tone="success">Confirmed</Badge>
              </div>
              <p className="flex items-center gap-2 text-muted-foreground">
                <CalendarClock className="size-4 shrink-0" aria-hidden="true" />
                <span className="tabular-nums">Mon, Oct 5 · 2:30 PM to 3:00 PM EDT</span>
              </p>
              <p className="flex items-center gap-2 text-muted-foreground">
                <MapPin className="size-4 shrink-0" aria-hidden="true" />
                Bluewave Dental
              </p>
            </div>
          </Message>
        </div>

        <div aria-hidden="true" className="flex items-center gap-2 border-t border-border px-4 py-3">
          <span className="flex-1 truncate rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
            Type a message
          </span>
          <span className="grid size-10 place-items-center rounded-lg bg-accent text-accent-foreground">
            <SendHorizontal className="size-4" />
          </span>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted-foreground">
        Illustration of a conversation. The business, times and names are examples.
      </figcaption>
    </figure>
  );
}
