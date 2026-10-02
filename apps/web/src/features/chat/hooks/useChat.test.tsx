import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SOCKET_EVENTS, type AssistantTurnDto } from '@appt/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, chatApi } from '@/lib/api';
import { COMPLETE_DRAFT, SESSION_ID, message, session, turn } from '../test/factories';
import { useChat } from './useChat';

// The provider needs a socket; the hook only needs to be able to receive pushes.
const handlers = new Map<string, (payload: never) => void>();
vi.mock('@/providers/RealtimeProvider', () => ({
  useRealtimeEvent: (event: string, handler: (payload: never) => void) => {
    handlers.set(event, handler);
  },
}));

const push = (event: string, payload: unknown) => act(() => handlers.get(event)?.(payload as never));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useChat(), { wrapper }) };
}

const existing = session({ messageCount: 2, lastMessageAt: '2026-10-02T13:00:00.000Z' });
const transcript = {
  session: existing,
  messages: [message({ id: '1', role: 'user', content: 'Book a checkup' }), message({ id: '2', role: 'assistant' })],
};

beforeEach(() => {
  handlers.clear();
  vi.spyOn(chatApi, 'listSessions').mockResolvedValue([existing]);
  vi.spyOn(chatApi, 'getTranscript').mockResolvedValue(transcript);
});

afterEach(() => vi.restoreAllMocks());

describe('useChat', () => {
  it('resumes the latest unfinished conversation and hydrates its transcript', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.activeKey).toBe(SESSION_ID);
    expect(result.current.historyState).toBe('ready');
  });

  it('starts a fresh conversation when the latest one is finished', async () => {
    vi.mocked(chatApi.listSessions).mockResolvedValue([{ ...existing, status: 'completed' }]);
    const { result } = setup();
    await waitFor(() => expect(result.current.activeKey).toBe('new'));
    expect(result.current.items).toEqual([]);
    expect(chatApi.getTranscript).not.toHaveBeenCalled();
  });

  it('starts fresh, and still works, when the session list cannot be loaded', async () => {
    vi.mocked(chatApi.listSessions).mockRejectedValue(new ApiError({ status: 0, code: 'NETWORK', message: 'offline' }));
    const { result } = setup();
    await waitFor(() => expect(result.current.activeKey).toBe('new'));
  });

  it('shows the message at once, then reconciles with the reply and mirrors the draft', async () => {
    let finish!: (value: AssistantTurnDto) => void;
    vi.spyOn(chatApi, 'sendMessage').mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { result } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    act(() => {
      expect(result.current.send('  make it 2pm  ')).toBe(true);
    });
    expect(result.current.items.at(-1)).toMatchObject({ content: 'make it 2pm', status: 'pending' });
    expect(result.current.isTyping).toBe(true);
    // A second message waits for the first reply.
    act(() => {
      expect(result.current.send('hello?')).toBe(false);
    });
    await waitFor(() =>
      expect(chatApi.sendMessage).toHaveBeenCalledExactlyOnceWith({ content: 'make it 2pm', sessionId: SESSION_ID }),
    );

    await act(async () => {
      finish(
        turn({ userMessageId: '3', userContent: 'make it 2pm', messageId: '4', action: 'confirm', bookingDraft: COMPLETE_DRAFT, missing: [] }),
      );
    });
    await waitFor(() => expect(result.current.isTyping).toBe(false));
    expect(result.current.items.map((item) => [item.role, item.id, item.status])).toEqual([
      ['user', '1', 'sent'],
      ['assistant', '2', 'sent'],
      ['user', '3', 'sent'],
      ['assistant', '4', 'sent'],
    ]);
    expect(result.current.draft).toEqual(COMPLETE_DRAFT);
    expect(result.current.turns['4']?.action).toBe('confirm');
  });

  it('ignores empty input', async () => {
    const send = vi.spyOn(chatApi, 'sendMessage');
    const { result } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    act(() => {
      expect(result.current.send('   ')).toBe(false);
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a failed message, then sends the same text again on retry', async () => {
    vi.spyOn(chatApi, 'sendMessage')
      .mockRejectedValueOnce(new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'slow down', retryAfterSeconds: 5 }))
      .mockResolvedValueOnce(turn({ userMessageId: '3', userContent: 'Move it to Friday', messageId: '4' }));
    const { result } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    act(() => void result.current.send('Move it to Friday'));
    await waitFor(() => expect(result.current.items.at(-1)?.status).toBe('failed'));
    const failed = result.current.items.at(-1)!;
    expect(failed.content).toBe('Move it to Friday');
    expect(failed.failure?.retryAfterSeconds).toBe(5);

    act(() => result.current.retry(failed.key));
    await waitFor(() => expect(result.current.items.at(-1)?.role).toBe('assistant'));
    expect(chatApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(chatApi.sendMessage).mock.calls[1]?.[0].content).toBe('Move it to Friday');
    expect(result.current.items.filter((item) => item.role === 'user' && item.content === 'Move it to Friday')).toHaveLength(1);
  });

  it('moves a new conversation onto the id the server assigns', async () => {
    vi.mocked(chatApi.listSessions).mockResolvedValue([]);
    vi.spyOn(chatApi, 'sendMessage').mockResolvedValue(
      turn({ sessionId: 'brand-new-session', userMessageId: '8', userContent: 'hi', messageId: '9' }),
    );
    vi.mocked(chatApi.getTranscript).mockResolvedValue({
      session: session({ id: 'brand-new-session' }),
      messages: [message({ id: '8', role: 'user', content: 'hi' }), message({ id: '9', role: 'assistant' })],
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.activeKey).toBe('new'));

    act(() => void result.current.send('hi'));
    await waitFor(() => expect(chatApi.sendMessage).toHaveBeenCalledWith({ content: 'hi', sessionId: undefined }));

    await waitFor(() => expect(result.current.activeKey).toBe('brand-new-session'));
    await waitFor(() => expect(chatApi.getTranscript).toHaveBeenCalledWith('brand-new-session', expect.anything()));
    // Hydration swaps in the server's copy without duplicating or remounting anything.
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['8', '9']));
    expect(result.current.items[0]?.key).toMatch(/^local-/);
  });

  it('does not double a turn the socket echoes back to the sender', async () => {
    const reply = turn({ userMessageId: '3', userContent: 'make it 2pm', messageId: '4' });
    vi.spyOn(chatApi, 'sendMessage').mockResolvedValue(reply);
    const { result } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    act(() => void result.current.send('make it 2pm'));
    await waitFor(() => expect(result.current.items.at(-1)?.role).toBe('assistant'));
    push(SOCKET_EVENTS.ASSISTANT_TURN, reply);

    expect(result.current.items.filter((item) => item.id === '4')).toHaveLength(1);
  });

  it('shows a turn produced in another tab', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    push(
      SOCKET_EVENTS.ASSISTANT_TURN,
      turn({ userMessageId: '5', userContent: 'From my phone', messageId: '6', content: 'Sent from another tab' }),
    );

    expect(result.current.items.slice(-2)).toMatchObject([
      { id: '5', role: 'user', content: 'From my phone' },
      { id: '6', role: 'assistant', content: 'Sent from another tab' },
    ]);
  });

  it('shows the assistant typing for a turn started in another tab, and fetches the question it answers', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(chatApi.getTranscript).toHaveBeenCalledTimes(1);

    push(SOCKET_EVENTS.ASSISTANT_TYPING, { sessionId: SESSION_ID, typing: true });
    expect(result.current.isTyping).toBe(true);
    await waitFor(() => expect(chatApi.getTranscript).toHaveBeenCalledTimes(2));

    push(SOCKET_EVENTS.ASSISTANT_TYPING, { sessionId: SESSION_ID, typing: false });
    expect(result.current.isTyping).toBe(false);
  });

  it('ignores typing in a conversation this tab is not showing', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    push(SOCKET_EVENTS.ASSISTANT_TYPING, { sessionId: 'some-other-session', typing: true });
    expect(result.current.isTyping).toBe(false);
  });

  it('stops showing remote typing if the turn never arrives', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    vi.useFakeTimers();
    try {
      push(SOCKET_EVENTS.ASSISTANT_TYPING, { sessionId: SESSION_ID, typing: true });
      expect(result.current.isTyping).toBe(true);
      act(() => vi.advanceTimersByTime(15_000));
      expect(result.current.isTyping).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('a conversation that already booked (SESSION_CLOSED)', () => {
    const closed = () =>
      new ApiError({
        status: 409,
        code: 'SESSION_CLOSED',
        message: 'This conversation has already booked its appointment. Start a new one to book again.',
      });

    it('closes the conversation and keeps the refused text, offering to send it in a new one', async () => {
      vi.spyOn(chatApi, 'sendMessage').mockRejectedValueOnce(closed());
      const { result } = setup();
      await waitFor(() => expect(result.current.items).toHaveLength(2));

      act(() => void result.current.send('Also a cleaning please'));
      await waitFor(() => expect(result.current.items.at(-1)?.status).toBe('failed'));
      expect(result.current.items.at(-1)?.failure).toMatchObject({ sessionClosed: true });
      expect(result.current.sessionStatus).toBe('completed');
      // The booking happened elsewhere; the transcript is refetched to show it.
      await waitFor(() => expect(chatApi.getTranscript).toHaveBeenCalledTimes(2));
    });

    it('moves the refused text into a new conversation on retry, and sends it there', async () => {
      vi.spyOn(chatApi, 'sendMessage')
        .mockRejectedValueOnce(closed())
        .mockResolvedValueOnce(
          turn({ sessionId: 'next-session', userMessageId: '30', userContent: 'Also a cleaning please', messageId: '31' }),
        );
      const { result } = setup();
      await waitFor(() => expect(result.current.items).toHaveLength(2));

      act(() => void result.current.send('Also a cleaning please'));
      await waitFor(() => expect(result.current.items.at(-1)?.status).toBe('failed'));
      act(() => result.current.retry(result.current.items.at(-1)!.key));

      await waitFor(() => expect(result.current.activeKey).toBe('next-session'));
      expect(vi.mocked(chatApi.sendMessage).mock.calls[1]?.[0]).toEqual({ content: 'Also a cleaning please', sessionId: undefined });
      expect(result.current.items.map((item) => item.id)).toEqual(['30', '31']);

      act(() => result.current.selectSession(SESSION_ID));
      expect(result.current.items.map((item) => item.id)).toEqual(['1', '2']);
    });

    it('closes the conversation when the form is refused for the same reason', async () => {
      const refusal = closed();
      vi.spyOn(chatApi, 'submitDraft').mockRejectedValue(refusal);
      const { result } = setup();
      await waitFor(() => expect(result.current.items).toHaveLength(2));

      await act(async () => {
        await expect(result.current.submitForm({ serviceName: 'Routine Checkup' })).rejects.toBe(refusal);
      });
      expect(result.current.sessionStatus).toBe('completed');
    });
  });

  it('creates a conversation first when the form is used before anything was said', async () => {
    vi.mocked(chatApi.listSessions).mockResolvedValue([]);
    vi.spyOn(chatApi, 'createSession').mockResolvedValue(session({ id: 'fresh' }));
    const submit = vi
      .spyOn(chatApi, 'submitDraft')
      .mockResolvedValue(turn({ sessionId: 'fresh', action: 'booked', bookingDraft: COMPLETE_DRAFT, missing: [] }));
    vi.mocked(chatApi.getTranscript).mockResolvedValue({ session: session({ id: 'fresh', status: 'completed' }), messages: [] });
    const { result } = setup();
    await waitFor(() => expect(result.current.activeKey).toBe('new'));

    let resolved: AssistantTurnDto | undefined;
    await act(async () => {
      resolved = await result.current.submitForm({ serviceName: 'Routine Checkup', date: '2026-10-05', time: '14:00' });
    });

    expect(resolved?.action).toBe('booked');
    expect(submit).toHaveBeenCalledWith({ sessionId: 'fresh', slots: { serviceName: 'Routine Checkup', date: '2026-10-05', time: '14:00' } });
    expect(result.current.activeKey).toBe('fresh');
    expect(result.current.sessionStatus).toBe('completed');
  });

  it('lets the form reject with the API error so it can map it onto fields', async () => {
    const taken = new ApiError({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'Some booking details need attention',
      details: { serviceName: ['We offer: Routine Checkup'] },
    });
    vi.spyOn(chatApi, 'submitDraft').mockRejectedValue(taken);
    const { result } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    await act(async () => {
      await expect(result.current.submitForm({ serviceName: 'Routine Checkup' })).rejects.toBe(taken);
    });
  });

  it('switches conversations instantly from the cache', async () => {
    const other = session({ id: 'other-session', title: 'Another', messageCount: 1 });
    vi.mocked(chatApi.listSessions).mockResolvedValue([existing, other]);
    vi.mocked(chatApi.getTranscript).mockImplementation(async (id) =>
      id === 'other-session'
        ? { session: other, messages: [message({ id: '20', role: 'user', content: 'In the other one' })] }
        : transcript,
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    act(() => result.current.selectSession('other-session'));
    await waitFor(() => expect(result.current.items.map((item) => item.content)).toEqual(['In the other one']));

    act(() => result.current.selectSession(SESSION_ID));
    expect(result.current.items).toHaveLength(2);
  });
});
