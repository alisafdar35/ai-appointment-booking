'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { statusFilter } from '@/lib/api';
import { useAppointments, useServices } from '@/lib/queries';
import { useCurrentUser } from '@/providers/AuthProvider';
import { useChat } from '../hooks/useChat';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { NEW_SESSION_KEY, type SessionKey } from '../lib/reducer';
import { ConversationPanel } from './ConversationPanel';
import { SessionList } from './SessionList';
import { SideRail } from './SideRail';

/**
 * Bookings still going ahead, soonest first, for the rail. Cancelled ones are
 * excluded by the query, so the rail is never short. A conversation's booked
 * card does not depend on this window: its row comes with the transcript.
 */
const UPCOMING_FILTERS = { window: 'upcoming', status: statusFilter(['pending', 'confirmed']), limit: 20 } as const;
const EMPTY_SERVICES: never[] = [];

/**
 * The assistant page: conversation list, conversation, and a rail with the
 * booking draft and upcoming appointments.
 *
 * The three regions appear as the screen allows. Wide screens show all three;
 * narrower ones move the list into a dialog; below the rail's breakpoint the
 * rail shrinks to a summary bar above the composer. The regions that are not
 * on screen are not rendered at all, so there is never a hidden duplicate for
 * assistive technology to trip over.
 */
export function ChatWorkspace() {
  const { businessTimezone: timeZone, businessName, role } = useCurrentUser();
  const chat = useChat();
  const services = useServices();
  const appointments = useAppointments(UPCOMING_FILTERS);

  const showRail = useMediaQuery('(min-width: 1024px)');
  const showSessionList = useMediaQuery('(min-width: 1280px)');
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);

  const { sessions, activeKey } = chat;
  const title =
    activeKey === NEW_SESSION_KEY || activeKey === undefined
      ? 'New conversation'
      : (sessions.data?.find((session) => session.id === activeKey)?.title ?? 'Conversation');

  // Choosing a conversation is choosing to write in it, so the cursor follows.
  const select = (key: SessionKey) => {
    chat.selectSession(key);
    setSessionsOpen(false);
    setComposerFocusRequest((count) => count + 1);
  };
  const startNew = () => {
    chat.startNewConversation();
    setSessionsOpen(false);
    setComposerFocusRequest((count) => count + 1);
  };

  const sessionList = (
    <SessionList
      sessions={sessions.data}
      isPending={sessions.isPending}
      isError={sessions.isError}
      onRetry={() => void sessions.refetch()}
      activeKey={activeKey}
      timeZone={timeZone}
      onSelect={select}
      onNew={startNew}
    />
  );

  const rail = (
    <SideRail
      draft={chat.draft}
      completed={chat.sessionStatus === 'completed'}
      timeZone={timeZone}
      appointments={appointments.data}
      appointmentsPending={appointments.isPending}
      appointmentsError={appointments.isError}
      businessWide={role !== 'customer'}
    />
  );

  return (
    <>
      <h1 className="sr-only">Assistant</h1>
      <div className="flex h-[calc(100dvh_-_var(--app-header-height)_-_3rem)] min-h-[32rem] gap-4 sm:h-[calc(100dvh_-_var(--app-header-height)_-_4rem)]">
        {showSessionList ? (
          <aside aria-label="Conversations" className="w-60 shrink-0 rounded-xl border border-border bg-surface p-3 shadow-card">
            {sessionList}
          </aside>
        ) : null}

        <section
          aria-label="Conversation with the booking assistant"
          className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-surface shadow-card"
        >
          <ConversationPanel
            chat={chat}
            title={title}
            timeZone={timeZone}
            businessName={businessName}
            services={services.data ?? EMPTY_SERVICES}
            onOpenSessions={showSessionList ? undefined : () => setSessionsOpen(true)}
            onOpenSummary={showRail ? undefined : () => setSummaryOpen(true)}
            composerFocusRequest={composerFocusRequest}
          />
        </section>

        {showRail ? (
          <aside aria-label="Booking details" className="w-72 shrink-0 overflow-y-auto">
            {rail}
          </aside>
        ) : null}
      </div>

      <Dialog open={sessionsOpen && !showSessionList} onOpenChange={setSessionsOpen} title="Conversations">
        <div className="h-[min(55dvh,28rem)]">{sessionList}</div>
      </Dialog>
      <Dialog open={summaryOpen && !showRail} onOpenChange={setSummaryOpen} title="Booking details">
        {rail}
      </Dialog>
    </>
  );
}
