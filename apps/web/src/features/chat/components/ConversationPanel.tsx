'use client';

import { ArrowDown, MessagesSquare, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppointmentDto, BookingSlots, ServiceDto } from '@appt/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { todayInZone } from '@/lib/datetime';
import { cn } from '@/lib/utils';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useStickToBottom } from '../hooks/useStickToBottom';
import type { ChatController } from '../hooks/useChat';
import { deriveQuickReplies } from '../lib/chips';
import { downloadTextFile } from '../lib/download';
import type { FormReason } from '../lib/fallback-form';
import { buildIcs, icsFileName } from '../lib/ics';
import { NEW_SESSION_KEY } from '../lib/reducer';
import { liveItemKey, turnMetaFor, type TurnContext } from '../lib/turn-meta';
import { Composer, type ComposerHandle } from './Composer';
import { DraftSummaryBar } from './DraftSummaryBar';
import { EngineNotice } from './EngineNotice';
import { FallbackFormCard } from './FallbackFormCard';
import { MessageList } from './MessageList';
import { QuickReplies } from './QuickReplies';
import { StarterPrompts } from './StarterPrompts';
import { TypingIndicator } from './TypingIndicator';

/** What a click on "Confirm booking" says. Both engines read this as consent to the summary just shown. */
const CONFIRM_MESSAGE = 'Yes, book it';

interface ConversationPanelProps {
  chat: ChatController;
  title: string;
  timeZone: string;
  businessName: string;
  services: readonly ServiceDto[];
  /** Below the xl breakpoint the conversation list lives behind a button. */
  onOpenSessions?: () => void;
  /** Below the lg breakpoint the right rail collapses into a bar above the composer. */
  onOpenSummary?: () => void;
  /** Bumped when the user picks or starts a conversation: their next step is to type in it. */
  composerFocusRequest?: number;
}

const isCoarsePointer = () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

export function ConversationPanel({
  chat,
  title,
  timeZone,
  businessName,
  services,
  onOpenSessions,
  onOpenSummary,
  composerFocusRequest = 0,
}: ConversationPanelProps) {
  const { items, draft, sessionStatus, isSending, isTyping, historyState, activeKey } = chat;
  const online = useOnlineStatus();
  const composerRef = useRef<ComposerHandle>(null);
  const formRef = useRef<HTMLDivElement>(null);

  // ---- what is live: only the newest assistant message can be acted on -----
  const turnContext: TurnContext = { turns: chat.turns, draft, status: sessionStatus, appointments: chat.appointments };
  const liveKey = liveItemKey(items);
  const liveItem = liveKey ? items[items.length - 1] : undefined;
  const liveMeta = liveItem ? turnMetaFor(liveItem, true, turnContext) : null;
  const completed = sessionStatus === 'completed';

  // ---- the structured form: opened by the user, or offered by a needs_form turn
  const [manualForm, setManualForm] = useState<{ key: string; reason: FormReason } | null>(null);
  const [dismissedFormFor, setDismissedFormFor] = useState<string | null>(null);
  const offeredByTurn = liveMeta?.action === 'needs_form' && dismissedFormFor !== liveKey;
  const formReason: FormReason | null =
    manualForm && manualForm.key === activeKey ? manualForm.reason : offeredByTurn ? 'stalled' : null;
  const formOpen = formReason !== null && !completed;

  const closeForm = () => {
    setManualForm(null);
    if (liveKey) setDismissedFormFor(liveKey);
  };
  const openForm = (reason: FormReason) => setManualForm({ key: activeKey ?? NEW_SESSION_KEY, reason });
  // Submitting from a new conversation creates it first and switches to its
  // id; the form moves with it, or it would unmount with its request in flight
  // and any error it gets back would have nowhere to show.
  const submitForm = (slots: Partial<BookingSlots>) =>
    chat.submitForm(slots, (sessionId) =>
      setManualForm((current) => (current?.key === NEW_SESSION_KEY ? { ...current, key: sessionId } : current)),
    );

  useEffect(() => {
    if (!formOpen) return;
    formRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    formRef.current?.querySelector<HTMLElement>('select, input, button')?.focus({ preventScroll: true });
  }, [formOpen]);

  // ---- the "guided mode" notice: once per conversation, dismissible --------
  // Only the deterministic engine standing in for the model triggers it. A
  // form submission (engine "system") involved no language understanding, so
  // it says nothing about whether the AI is available.
  const [dismissedNotices, setDismissedNotices] = useState<ReadonlySet<string>>(new Set());
  const noticeKey = activeKey ?? NEW_SESSION_KEY;
  const showEngineNotice =
    !dismissedNotices.has(noticeKey) && items.some((item) => item.role === 'assistant' && item.engine === 'fallback');

  const showStarters = historyState === 'ready' && items.length === 0 && !formOpen;

  // ---- scrolling ---------------------------------------------------------------
  const { scrollerRef, contentRef, onScroll, showJump, follow, jumpToLatest } = useStickToBottom<
    HTMLDivElement,
    HTMLDivElement
  >({
    resetKey: noticeKey,
    changeKey: `${items.length}|${isTyping}|${formOpen}|${liveMeta?.action ?? ''}`,
    ready: historyState === 'ready',
    pinToTop: showStarters,
  });

  // After a turn lands, or a conversation opens, put the cursor where the next
  // message is typed. Not on touch devices, where it would raise the keyboard
  // uninvited, and not when the user has moved into the form.
  useEffect(() => {
    if (isCoarsePointer()) return;
    const active = document.activeElement;
    const adrift =
      !active ||
      active === document.body ||
      (scrollerRef.current?.contains(active) === true && !active.closest('#booking-form'));
    if (adrift) composerRef.current?.focus();
  }, [liveKey, activeKey, scrollerRef]);

  // The effect above leaves focus alone when it sits outside the transcript, and
  // after a click in the conversation list it does: on the button just pressed,
  // where typed text went nowhere and Enter started yet another conversation.
  // The frame's delay lets a closing conversations dialog return focus first.
  useEffect(() => {
    if (composerFocusRequest === 0 || isCoarsePointer()) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [composerFocusRequest]);

  // Sending is the reader asking to see the answer, wherever they had scrolled to.
  const send = (text: string) => {
    follow();
    return chat.send(text);
  };

  const addToCalendar = (appointment: AppointmentDto) =>
    downloadTextFile(icsFileName(appointment, timeZone), buildIcs(appointment, { businessName }), 'text/calendar;charset=utf-8');

  const quickReplies =
    liveMeta && liveKey && !isSending && !completed && !formOpen
      ? deriveQuickReplies({ meta: liveMeta, draft, services, today: todayInZone(timeZone), timeZone })
      : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
        {onOpenSessions ? (
          <Button variant="ghost" size="sm" onClick={onOpenSessions} leftIcon={<MessagesSquare className="size-4" aria-hidden="true" />}>
            Conversations
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground sm:text-base">{title}</h2>
      </header>

      {showEngineNotice ? (
        <div className="border-b border-border px-3 py-2 sm:px-4">
          <EngineNotice onDismiss={() => setDismissedNotices((current) => new Set(current).add(noticeKey))} />
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollerRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain px-3 py-4 sm:px-4">
          <div ref={contentRef} className={cn('space-y-4', showStarters && 'min-h-full')}>
            {/* A conversation the form just created has nothing to load yet; the form is the content. */}
            {historyState === 'loading' && !formOpen ? (
              <div role="status" className="space-y-4">
                <span className="sr-only">Loading conversation</span>
                <Skeleton className="h-10 w-2/3 rounded-2xl" />
                <Skeleton className="ml-auto h-10 w-1/2 rounded-2xl" />
                <Skeleton className="h-16 w-3/4 rounded-2xl" />
              </div>
            ) : historyState === 'error' ? (
              <Alert
                tone="error"
                title="We couldn't load this conversation"
                action={
                  <Button size="sm" variant="secondary" onClick={() => void chat.reloadHistory()}>
                    Try again
                  </Button>
                }
              >
                Your messages are safe. Check your connection and try again.
              </Alert>
            ) : showStarters ? (
              <StarterPrompts onPick={send} disabled={isSending} />
            ) : items.length > 0 ? (
              <MessageList
                items={items}
                context={turnContext}
                services={services}
                timeZone={timeZone}
                actions={{
                  onConfirm: () => send(CONFIRM_MESSAGE),
                  onChangeDetails: () => openForm('change'),
                  onResend: chat.resendLast,
                  onAddToCalendar: addToCalendar,
                }}
                onRetry={chat.retry}
              />
            ) : null}

            {isTyping ? <TypingIndicator /> : null}
            <QuickReplies replies={quickReplies} disabled={isSending} onPick={send} />

            {formOpen && formReason ? (
              <div ref={formRef} className="scroll-mb-4">
                <FallbackFormCard
                  reason={formReason}
                  draft={draft}
                  onSubmit={submitForm}
                  onBooked={closeForm}
                  onClose={closeForm}
                />
              </div>
            ) : null}
          </div>
        </div>

        {showJump ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={jumpToLatest}
            leftIcon={<ArrowDown className="size-4" aria-hidden="true" />}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-popover animate-fade-in"
          >
            Jump to latest
          </Button>
        ) : null}
      </div>

      <footer className="space-y-2 border-t border-border bg-surface px-3 pb-3 pt-3 sm:px-4">
        {onOpenSummary ? <DraftSummaryBar draft={draft} completed={completed} timeZone={timeZone} onOpen={onOpenSummary} /> : null}

        {online ? null : (
          <p role="status" className="flex items-center gap-2 text-xs text-warning-text">
            <WifiOff className="size-3.5 shrink-0" aria-hidden="true" />
            You&rsquo;re offline. Messages won&rsquo;t send until you reconnect, and any that fail can be retried.
          </p>
        )}

        {completed ? (
          <div className="flex flex-col items-start gap-3 rounded-xl bg-muted/60 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">This booking is complete. Start a new conversation to book another.</p>
            <Button onClick={chat.startNewConversation}>New conversation</Button>
          </div>
        ) : (
          <Composer
            ref={composerRef}
            onSend={send}
            sending={isSending}
            ready={historyState === 'ready'}
            formOpen={formOpen}
            onToggleForm={() => (formOpen ? closeForm() : openForm('requested'))}
          />
        )}
      </footer>
    </div>
  );
}
