import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { EMPTY_SLOTS, type AssistantAction, type BookingSlots } from '@appt/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, chatApi, servicesApi } from '@/lib/api';
import { useChat, type ChatController } from '../hooks/useChat';
import { downloadTextFile } from '../lib/download';
import type { ChatItem, TurnMeta } from '../lib/reducer';
import { CHECKUP, COMPLETE_DRAFT, WHITENING, appointment, session } from '../test/factories';
import { ConversationPanel } from './ConversationPanel';

vi.mock('@/providers/AuthProvider', () => ({ useBusinessTimezone: () => 'America/New_York' }));
vi.mock('../lib/download', () => ({ downloadTextFile: vi.fn() }));
// Only the real-controller tests below use it; live delivery is not under test.
vi.mock('@/providers/RealtimeProvider', () => ({ useRealtimeEvent: () => undefined }));

beforeAll(() => {
  // jsdom implements neither; the panel scrolls to the end and brings the form into view.
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.mocked(downloadTextFile).mockClear();
  vi.spyOn(servicesApi, 'list').mockResolvedValue([CHECKUP, WHITENING]);
});

const item = (id: string, role: ChatItem['role'], overrides: Partial<ChatItem> = {}): ChatItem => ({
  key: `message-${id}`,
  id,
  role,
  content: `${role} message ${id}`,
  engine: role === 'assistant' ? 'mistral' : null,
  action: null,
  createdAt: '2026-10-02T13:00:00.000Z',
  status: 'sent',
  ...overrides,
});

const meta = (action: AssistantAction, overrides: Partial<TurnMeta> = {}): TurnMeta => ({
  action,
  missing: [],
  bookingDraft: COMPLETE_DRAFT,
  ...overrides,
});

function controller(overrides: Partial<ChatController> = {}): ChatController {
  return {
    activeKey: 'session-1',
    sessionId: 'session-1',
    items: [],
    turns: {},
    appointments: [],
    draft: EMPTY_SLOTS,
    sessionStatus: 'active',
    isSending: false,
    isTyping: false,
    historyState: 'ready',
    reloadHistory: vi.fn(),
    send: vi.fn(() => true),
    retry: vi.fn(),
    resendLast: vi.fn(),
    submitForm: vi.fn(),
    selectSession: vi.fn(),
    startNewConversation: vi.fn(),
    ...overrides,
  } as unknown as ChatController;
}

function renderPanel(chat: ChatController, extra: { draft?: BookingSlots } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (children: ReactNode) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(
    wrap(
      <ConversationPanel
        chat={{ ...chat, draft: extra.draft ?? chat.draft }}
        title="Test conversation"
        timeZone="America/New_York"
        businessName="Bluewave Dental"
        services={[CHECKUP, WHITENING]}
      />,
    ),
  );
}

describe('ConfirmationCard', () => {
  const confirming = () =>
    controller({
      items: [item('1', 'user'), item('2', 'assistant')],
      turns: { '2': meta('confirm') },
      draft: COMPLETE_DRAFT,
    });

  it('summarises the booking from the structured draft, including price and duration', () => {
    renderPanel(confirming());
    const card = screen.getByRole('region', { name: 'Booking summary' });
    expect(within(card).getByText('Routine Checkup')).toBeInTheDocument();
    expect(within(card).getByText('Monday, October 5, 2026')).toBeInTheDocument();
    expect(within(card).getByText('2:00 PM EDT')).toBeInTheDocument();
    expect(within(card).getByText('30 minutes')).toBeInTheDocument();
    expect(within(card).getByText('$80')).toBeInTheDocument();
  });

  it('"Confirm booking" sends the consent the engines understand', async () => {
    const chat = confirming();
    renderPanel(chat);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(chat.send).toHaveBeenCalledExactlyOnceWith('Yes, book it');
  });

  it('"Change something" opens the form, prefilled, instead of sending a message the engines cannot act on', async () => {
    const chat = confirming();
    renderPanel(chat);
    await userEvent.click(screen.getByRole('button', { name: 'Change something' }));

    expect(chat.send).not.toHaveBeenCalled();
    const form = await screen.findByRole('region', { name: 'Book with a quick form' });
    expect(within(form).getByText(/change anything you like/i)).toBeInTheDocument();
    expect(await within(form).findByRole('combobox', { name: /service/i })).toHaveValue('Routine Checkup');
  });
});

describe('only the latest actionable card is interactive', () => {
  it('disables an earlier summary once a newer one exists', () => {
    renderPanel(
      controller({
        items: [item('1', 'user'), item('2', 'assistant'), item('3', 'user'), item('4', 'assistant')],
        turns: { '2': meta('confirm'), '4': meta('confirm', { bookingDraft: { ...COMPLETE_DRAFT, time: '15:00' } }) },
        draft: { ...COMPLETE_DRAFT, time: '15:00' },
      }),
    );

    const [earlier, latest] = screen.getAllByRole('region', { name: 'Booking summary' });
    expect(within(earlier!).getByRole('button', { name: 'Confirm booking' })).toBeDisabled();
    expect(within(earlier!).getByRole('button', { name: 'Change something' })).toBeDisabled();
    expect(within(earlier!).getByText('Earlier summary')).toBeInTheDocument();
    expect(within(latest!).getByRole('button', { name: 'Confirm booking' })).toBeEnabled();
    expect(within(latest!).queryByText('Earlier summary')).not.toBeInTheDocument();
  });

  it('disables the summary as soon as the user replies, before the next turn arrives', () => {
    renderPanel(
      controller({
        items: [item('1', 'user'), item('2', 'assistant'), item('local-3', 'user', { id: null, key: 'local-3', status: 'pending' })],
        turns: { '2': meta('confirm') },
        isSending: true,
        isTyping: true,
      }),
    );
    expect(screen.getByRole('button', { name: 'Confirm booking' })).toBeDisabled();
  });

  it('rebuilds every earlier summary from its own message after a reload, with only the latest live', () => {
    const earlierDraft = { ...COMPLETE_DRAFT, time: '10:00' };
    renderPanel(
      controller({
        items: [
          item('1', 'user'),
          item('2', 'assistant', { action: 'confirm', draft: earlierDraft }),
          item('3', 'user'),
          item('4', 'assistant', { action: 'confirm', draft: COMPLETE_DRAFT }),
        ],
        draft: COMPLETE_DRAFT,
      }),
    );

    const [earlier, latest] = screen.getAllByRole('region', { name: 'Booking summary' });
    expect(within(earlier!).getByText('10:00 AM EDT')).toBeInTheDocument();
    expect(within(earlier!).getByRole('button', { name: 'Confirm booking' })).toBeDisabled();
    expect(within(latest!).getByText('2:00 PM EDT')).toBeInTheDocument();
    expect(within(latest!).getByRole('button', { name: 'Confirm booking' })).toBeEnabled();
  });

  it('shows no card for an earlier summary stored before drafts were recorded', () => {
    renderPanel(
      controller({
        items: [item('1', 'user'), item('2', 'assistant', { action: 'confirm' }), item('3', 'user'), item('4', 'assistant', { action: 'collect_info' })],
        draft: COMPLETE_DRAFT,
      }),
    );
    expect(screen.queryByRole('region', { name: 'Booking summary' })).not.toBeInTheDocument();
  });

  it('restores the live summary after a reload from the action recorded on the message', () => {
    renderPanel(
      controller({ items: [item('1', 'user'), item('2', 'assistant', { action: 'confirm' })], draft: COMPLETE_DRAFT }),
    );
    expect(screen.getByRole('button', { name: 'Confirm booking' })).toBeEnabled();
  });

  it('infers the summary for a message stored before actions were recorded', () => {
    renderPanel(
      controller({ items: [item('1', 'user'), item('2', 'assistant', { action: null })], draft: COMPLETE_DRAFT }),
    );
    expect(screen.getByRole('button', { name: 'Confirm booking' })).toBeEnabled();
  });
});

describe('after a reload, from what the transcript recorded', () => {
  it('offers the form again when the last reply did', async () => {
    renderPanel(
      controller({
        items: [item('1', 'user'), item('2', 'assistant', { action: 'needs_form' })],
        draft: { ...EMPTY_SLOTS, serviceName: 'Routine Checkup' },
      }),
    );
    const form = await screen.findByRole('region', { name: 'Book with a quick form' });
    expect(within(form).getByText(/I'm having trouble pinning the details down/)).toBeInTheDocument();
  });

  it('offers the alternative times the last reply suggested', async () => {
    const draft = { serviceName: 'Routine Checkup', date: '2026-10-05', time: null, notes: null };
    const chat = controller({
      items: [
        item('1', 'user'),
        item('2', 'assistant', {
          action: 'collect_info',
          suggestions: [{ date: '2026-10-05', time: '15:30', label: '3:30 PM' }],
        }),
      ],
      draft,
    });
    renderPanel(chat);
    await userEvent.click(screen.getByRole('button', { name: '3:30 PM' }));
    expect(chat.send).toHaveBeenCalledExactlyOnceWith('Oct 5, 2026 at 3:30 PM');
  });

  it('does not offer a summary when the reply was still collecting, even if the draft is complete', () => {
    renderPanel(
      controller({ items: [item('1', 'user'), item('2', 'assistant', { action: 'collect_info' })], draft: COMPLETE_DRAFT }),
    );
    expect(screen.queryByRole('region', { name: 'Booking summary' })).not.toBeInTheDocument();
  });
});

describe('booked turn', () => {
  it('shows the booking with a link to the dashboard and a calendar download', async () => {
    const booked = appointment({ notes: 'Bring X-rays' });
    renderPanel(
      controller({
        items: [item('1', 'user'), item('2', 'assistant')],
        turns: { '2': meta('booked', { appointment: booked }) },
        sessionStatus: 'completed',
      }),
    );

    const card = screen.getByRole('region', { name: 'Booked appointment' });
    expect(within(card).getByText('Confirmed')).toBeInTheDocument();
    expect(within(card).getByText('2:00 PM – 2:30 PM')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'View in appointments' })).toHaveAttribute('href', '/appointments');

    await userEvent.click(within(card).getByRole('button', { name: 'Add to calendar' }));
    const [fileName, content, mime] = vi.mocked(downloadTextFile).mock.calls[0]!;
    expect(fileName).toBe('slotly-routine-checkup-2026-10-05.ics');
    expect(content).toContain('BEGIN:VCALENDAR');
    expect(content).toContain('DTSTART:20261005T180000Z');
    expect(mime).toBe('text/calendar;charset=utf-8');
  });

  it('after a reload, shows the booking from the transcript, however far off or long past it is', async () => {
    const booked = appointment({ id: 'far-off', startsAt: '2027-06-01T14:00:00.000Z', endsAt: '2027-06-01T14:30:00.000Z' });
    renderPanel(
      controller({
        items: [item('1', 'user'), item('2', 'assistant', { action: 'booked', draft: COMPLETE_DRAFT, appointmentId: 'far-off' })],
        appointments: [booked],
        draft: COMPLETE_DRAFT,
        sessionStatus: 'completed',
      }),
    );

    const card = screen.getByRole('region', { name: 'Booked appointment' });
    expect(within(card).getByText('Confirmed')).toBeInTheDocument();
    expect(within(card).getByText('Tuesday, June 1, 2027')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Add to calendar' }));
    expect(vi.mocked(downloadTextFile)).toHaveBeenCalledOnce();
  });

  it('after a reload, without the appointment (cancelled since), still shows what was booked from the message’s draft', () => {
    renderPanel(
      controller({
        items: [item('1', 'user'), item('2', 'assistant', { action: 'booked', draft: COMPLETE_DRAFT, appointmentId: 'gone' })],
        draft: EMPTY_SLOTS,
        sessionStatus: 'completed',
      }),
    );
    const card = screen.getByRole('region', { name: 'Booked appointment' });
    expect(within(card).getByText('Booked in this conversation')).toBeInTheDocument();
    expect(within(card).getByText('2:00 PM EDT')).toBeInTheDocument();
  });

  it('after a reload, without the appointment loaded, still shows what was booked from the session draft', () => {
    // The booking can be past, or beyond the upcoming list the page loads; the
    // receipt must not vanish, but it cannot vouch for a status it does not know.
    renderPanel(
      controller({
        items: [item('1', 'user'), item('2', 'assistant', { action: 'booked' })],
        draft: COMPLETE_DRAFT,
        sessionStatus: 'completed',
      }),
    );

    const card = screen.getByRole('region', { name: 'Booked appointment' });
    expect(within(card).getByText('Booked in this conversation')).toBeInTheDocument();
    expect(within(card).getByText('Routine Checkup')).toBeInTheDocument();
    expect(within(card).getByText('Monday, October 5, 2026')).toBeInTheDocument();
    expect(within(card).getByText('2:00 PM EDT')).toBeInTheDocument();
    expect(within(card).queryByText('Confirmed')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Add to calendar' })).not.toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'View in appointments' })).toHaveAttribute('href', '/appointments');
  });

  it('replaces the composer with a way to start over, so a stray "yes" cannot book twice', async () => {
    const chat = controller({
      items: [item('1', 'user'), item('2', 'assistant')],
      turns: { '2': meta('booked', { appointment: appointment() }) },
      sessionStatus: 'completed',
    });
    renderPanel(chat);

    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(chat.startNewConversation).toHaveBeenCalledOnce();
  });
});

describe('quick replies', () => {
  const collecting = (overrides: Partial<ChatController> = {}) =>
    controller({
      items: [item('1', 'user'), item('2', 'assistant')],
      turns: { '2': meta('collect_info', { missing: ['serviceName', 'date', 'time'], bookingDraft: EMPTY_SLOTS }) },
      ...overrides,
    });

  it('offers the services when the service is missing, and clicking one sends its name', async () => {
    const chat = collecting();
    renderPanel(chat);
    const group = screen.getByRole('group', { name: 'Suggested replies' });
    await userEvent.click(within(group).getByRole('button', { name: 'Teeth Whitening' }));
    expect(chat.send).toHaveBeenCalledExactlyOnceWith('Teeth Whitening');
  });

  it('is gone once the user has replied', () => {
    renderPanel(collecting({ items: [item('1', 'user'), item('2', 'assistant'), item('3', 'user')] }));
    expect(screen.queryByRole('group', { name: 'Suggested replies' })).not.toBeInTheDocument();
  });

  it('offers the alternatives the server suggested when a slot was taken', async () => {
    const chat = controller({
      items: [item('1', 'user'), item('2', 'assistant')],
      draft: { serviceName: 'Routine Checkup', date: '2026-10-05', time: null, notes: null },
      turns: {
        '2': meta('collect_info', {
          missing: ['time'],
          suggestions: [{ date: '2026-10-05', time: '15:00', label: '3:00 PM' }],
          bookingDraft: { serviceName: 'Routine Checkup', date: '2026-10-05', time: null, notes: null },
        }),
      },
    });
    renderPanel(chat);
    await userEvent.click(screen.getByRole('button', { name: '3:00 PM' }));
    expect(chat.send).toHaveBeenCalledExactlyOnceWith('Oct 5, 2026 at 3:00 PM');
  });
});

describe('needs_form', () => {
  it('shows the form with a kind explanation of why it appeared', async () => {
    renderPanel(
      controller({
        items: [item('1', 'user'), item('2', 'assistant')],
        turns: { '2': meta('needs_form', { missing: ['date'], bookingDraft: { ...EMPTY_SLOTS, serviceName: 'Routine Checkup' } }) },
        draft: { ...EMPTY_SLOTS, serviceName: 'Routine Checkup' },
      }),
    );
    const form = await screen.findByRole('region', { name: 'Book with a quick form' });
    expect(within(form).getByText(/I'm having trouble pinning the details down — a quick form will be faster/)).toBeInTheDocument();
  });

  it('can be dismissed, and the composer toggle reopens it as a requested form', async () => {
    renderPanel(
      controller({
        items: [item('1', 'user'), item('2', 'assistant')],
        turns: { '2': meta('needs_form', { missing: ['date'] }) },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Back to chat' }));
    expect(screen.queryByRole('region', { name: 'Book with a quick form' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Prefer a form?' }));
    expect(await screen.findByText(/prefer clicking to typing/i)).toBeInTheDocument();
  });
});

describe('empty conversation', () => {
  it('offers clickable starters built from the catalogue', async () => {
    const chat = controller({ activeKey: 'new', sessionId: null });
    renderPanel(chat);
    const starter = await screen.findByRole('button', { name: 'Book Routine Checkup tomorrow at 2pm' });
    await userEvent.click(starter);
    expect(chat.send).toHaveBeenCalledExactlyOnceWith('Book Routine Checkup tomorrow at 2pm');
  });
});

describe('failed and pending messages', () => {
  it('shows the failure inline with a working Retry, keeping the text', async () => {
    const chat = controller({
      items: [
        item('local-1', 'user', {
          id: null,
          key: 'local-1',
          content: 'Book a checkup',
          status: 'failed',
          failure: { message: "Couldn't reach the server. Check your connection and try again.", failedAt: Date.now() },
        }),
      ],
    });
    renderPanel(chat);
    expect(screen.getByText('Book a checkup')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't reach the server/i);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(chat.retry).toHaveBeenCalledExactlyOnceWith('local-1');
  });

  it('waits out a rate limit before enabling Retry', () => {
    renderPanel(
      controller({
        items: [
          item('local-1', 'user', {
            id: null,
            key: 'local-1',
            status: 'failed',
            failure: { message: "You're sending messages quickly.", retryAfterSeconds: 30, failedAt: Date.now() },
          }),
        ],
      }),
    );
    expect(screen.getByRole('button', { name: /Retry in \d+s/ })).toBeDisabled();
  });

  it('offers to send a message refused by a closed conversation in a new one', async () => {
    const chat = controller({
      sessionStatus: 'completed',
      items: [
        item('1', 'user'),
        item('2', 'assistant'),
        item('local-3', 'user', {
          id: null,
          key: 'local-3',
          content: 'Also a cleaning please',
          status: 'failed',
          failure: {
            message: 'This conversation has already booked its appointment, so this message was not sent.',
            sessionClosed: true,
            failedAt: Date.now(),
          },
        }),
      ],
    });
    renderPanel(chat);

    expect(screen.getByRole('alert')).toHaveTextContent(/already booked its appointment/);
    await userEvent.click(screen.getByRole('button', { name: 'Send in a new conversation' }));
    expect(chat.retry).toHaveBeenCalledExactlyOnceWith('local-3');
    // The composer is gone with the conversation; a fresh one is a click away.
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeInTheDocument();
  });

  it('shows a typing indicator while a reply is pending', () => {
    renderPanel(controller({ items: [item('local-1', 'user', { id: null, status: 'pending' })], isSending: true, isTyping: true }));
    expect(screen.getByText('The assistant is typing')).toBeInTheDocument();
    expect(screen.getByText(/Sending…/)).toBeInTheDocument();
  });
});

describe('engine transparency', () => {
  it('labels each engine, and shows the guided-mode notice once, dismissibly', async () => {
    renderPanel(
      controller({
        items: [item('1', 'user'), item('2', 'assistant', { engine: 'fallback' })],
        turns: { '2': meta('collect_info', { missing: ['date'] }) },
      }),
    );
    expect(screen.getByText('Guided mode')).toBeInTheDocument();
    const notice = screen.getByText(/Running in guided mode — I can still book your appointment\./);
    expect(notice).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(notice).not.toBeInTheDocument();
  });

  it('says nothing about guided mode when the AI answered', () => {
    renderPanel(controller({ items: [item('1', 'user'), item('2', 'assistant', { engine: 'mistral' })] }));
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.queryByText(/guided mode/i)).not.toBeInTheDocument();
  });

  it('labels nothing, and raises no guided-mode notice, for a reply to the booking form', () => {
    renderPanel(
      controller({
        items: [
          item('1', 'user', { content: 'Book Routine Checkup on Monday, October 5 at 2:00 PM.' }),
          item('2', 'assistant', { engine: 'system', action: 'booked' }),
        ],
        sessionStatus: 'completed',
      }),
    );
    expect(screen.queryByText('AI')).not.toBeInTheDocument();
    expect(screen.queryByText(/guided mode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/engine/)).not.toBeInTheDocument();
  });
});

describe('composer focus', () => {
  it('moves the cursor to the composer when a conversation is picked from the list', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const panel = (request: number) => (
      <QueryClientProvider client={client}>
        <button type="button">New conversation</button>
        <ConversationPanel
          chat={controller()}
          title="Test conversation"
          timeZone="America/New_York"
          businessName="Bluewave Dental"
          services={[CHECKUP, WHITENING]}
            composerFocusRequest={request}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(panel(0));
    const listButton = screen.getByRole('button', { name: 'New conversation' });
    listButton.focus();

    rerender(panel(1));

    await vi.waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus());
  });
});

describe('the form in a brand-new conversation (real controller)', () => {
  // Submitting creates the conversation first and switches to its id while the
  // draft request is still in flight; the form has to survive that switch.
  function ConnectedPanel() {
    const chat = useChat();
    return (
      <ConversationPanel
        chat={chat}
        title="New conversation"
        timeZone="America/New_York"
        businessName="Bluewave Dental"
        services={[CHECKUP, WHITENING]}
      />
    );
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-02T14:00:00.000Z') });
    vi.spyOn(chatApi, 'listSessions').mockResolvedValue([]);
    vi.spyOn(chatApi, 'createSession').mockResolvedValue(session({ id: 'fresh', messageCount: 0 }));
    vi.spyOn(chatApi, 'getTranscript').mockResolvedValue({ session: session({ id: 'fresh', messageCount: 0 }), messages: [], appointments: [] });
    vi.spyOn(servicesApi, 'availability').mockResolvedValue({
      date: '2026-10-05',
      serviceId: CHECKUP.id,
      durationMinutes: 30,
      slots: [{ time: '14:00', available: true }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function submitFreshForm() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ConnectedPanel />
      </QueryClientProvider>,
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole('button', { name: 'Prefer a form?' }));
    const form = await screen.findByRole('region', { name: 'Book with a quick form' });
    await within(form).findByRole('option', { name: /Routine Checkup/ });
    await user.selectOptions(within(form).getByRole('combobox', { name: /service/i }), 'Routine Checkup');
    await user.type(within(form).getByLabelText(/^Date/), '2026-10-05');
    await user.click(await within(form).findByRole('radio', { name: '2:00 PM' }));
    await user.click(within(form).getByRole('button', { name: 'Book appointment' }));
    await waitFor(() => expect(chatApi.submitDraft).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'fresh' })));
  }

  it('keeps the form, with the field error, when the server rejects a field', async () => {
    vi.spyOn(chatApi, 'submitDraft').mockRejectedValue(
      new ApiError({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'Some booking details need attention',
        details: { serviceName: ['We offer: Routine Checkup, Teeth Whitening'] },
      }),
    );
    await submitFreshForm();

    expect(await screen.findByText('We offer: Routine Checkup, Teeth Whitening')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Book with a quick form' })).toBeInTheDocument();
  });

  it('keeps the form, with an error alert, when the server fails', async () => {
    vi.spyOn(chatApi, 'submitDraft').mockRejectedValue(
      new ApiError({ status: 500, code: 'INTERNAL', message: 'Something went wrong on our side.' }),
    );
    await submitFreshForm();

    const form = screen.getByRole('region', { name: 'Book with a quick form' });
    expect(await within(form).findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    expect(within(form).getByRole('button', { name: 'Book appointment' })).toBeEnabled();
  });
});
