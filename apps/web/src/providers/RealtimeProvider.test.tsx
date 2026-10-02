import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SOCKET_EVENTS, type AppointmentDto } from '@appt/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '@/lib/api';
import { queryKeys } from '@/lib/queries';
import { RealtimeProvider, useRealtimeEvent, useRealtimeStatus } from './RealtimeProvider';

type Listener = (...args: unknown[]) => void;

/** Just enough of a Socket.IO client to drive the provider from the test. */
class FakeSocket {
  listeners = new Map<string, Set<Listener>>();
  connect = vi.fn();
  disconnect = vi.fn();
  on(event: string, listener: Listener) {
    this.listeners.set(event, (this.listeners.get(event) ?? new Set()).add(listener));
    return this;
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  removeAllListeners() {
    this.listeners.clear();
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }
  count(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }
}

const mocks = vi.hoisted(() => ({
  auth: { status: 'authenticated', user: { id: 'u1' } as { id: string } | null },
  sockets: [] as unknown[],
  renewSession: vi.fn(),
}));

vi.mock('./AuthProvider', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/socket', () => ({
  createSocket: () => {
    const socket = new FakeSocket();
    mocks.sockets.push(socket);
    return socket;
  },
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  renewSession: mocks.renewSession,
}));

const latestSocket = () => mocks.sockets[mocks.sockets.length - 1] as FakeSocket;

const appointment: AppointmentDto = {
  id: 'a1',
  status: 'confirmed',
  source: 'chat',
  startsAt: '2099-10-06T15:00:00.000Z',
  endsAt: '2099-10-06T15:30:00.000Z',
  notes: null,
  cancellationReason: null,
  chatSessionId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  service: { id: 'svc', name: 'Cleaning', description: null, durationMinutes: 30, priceCents: 9000 },
  customer: { id: 'u1', fullName: 'Casey Customer', email: 'casey@example.test' },
};

function setup() {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider>{children}</RealtimeProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

beforeEach(() => {
  mocks.sockets.length = 0;
  mocks.renewSession.mockReset();
  mocks.auth.status = 'authenticated';
  mocks.auth.user = { id: 'u1' };
});

describe('RealtimeProvider', () => {
  it('connects only while authenticated', async () => {
    mocks.auth.status = 'unauthenticated';
    mocks.auth.user = null;
    const { wrapper } = setup();
    renderHook(() => useRealtimeStatus(), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.sockets).toHaveLength(0);
  });

  it('reports connecting -> connected -> degraded -> connecting as the socket changes state', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useRealtimeStatus(), { wrapper });
    await waitFor(() => expect(latestSocket().connect).toHaveBeenCalled());
    expect(result.current).toBe('connecting');

    act(() => latestSocket().fire('connect'));
    expect(result.current).toBe('connected');

    act(() => latestSocket().fire('disconnect', 'transport close'));
    expect(result.current).toBe('connecting');

    act(() => latestSocket().fire('connect_error', new Error('xhr poll error')));
    expect(result.current).toBe('degraded');

    act(() => latestSocket().fire('connect'));
    expect(result.current).toBe('connected');
  });

  it('renews the session and reconnects once when the handshake is rejected as UNAUTHENTICATED', async () => {
    mocks.renewSession.mockResolvedValue({});
    const { wrapper } = setup();
    renderHook(() => useRealtimeStatus(), { wrapper });
    await waitFor(() => expect(latestSocket().connect).toHaveBeenCalledTimes(1));

    act(() => latestSocket().fire('connect_error', new Error('UNAUTHENTICATED')));
    await waitFor(() => expect(latestSocket().connect).toHaveBeenCalledTimes(2));
    expect(mocks.renewSession).toHaveBeenCalledTimes(1);

    // Still rejected after a renewal: do not loop.
    act(() => latestSocket().fire('connect_error', new Error('UNAUTHENTICATED')));
    expect(mocks.renewSession).toHaveBeenCalledTimes(1);
  });

  it('merges appointment events into the query cache', async () => {
    const { wrapper, queryClient } = setup();
    queryClient.setQueryData(queryKeys.appointments.list({}), []);
    renderHook(() => useRealtimeStatus(), { wrapper });
    await waitFor(() => expect(latestSocket().connect).toHaveBeenCalled());

    act(() => latestSocket().fire(SOCKET_EVENTS.APPOINTMENT_CREATED, { appointment }));
    expect(queryClient.getQueryData<AppointmentDto[]>(queryKeys.appointments.list({}))).toEqual([appointment]);

    const cancelled = { ...appointment, status: 'cancelled' as const };
    act(() => latestSocket().fire(SOCKET_EVENTS.APPOINTMENT_UPDATED, { appointment: cancelled }));
    expect(queryClient.getQueryData<AppointmentDto[]>(queryKeys.appointments.list({}))).toEqual([cancelled]);
  });

  it('refetches appointments after a reconnect, because events missed while offline are gone', async () => {
    const { wrapper, queryClient } = setup();
    queryClient.setQueryData(queryKeys.appointments.list({}), []);
    renderHook(() => useRealtimeStatus(), { wrapper });
    await waitFor(() => expect(latestSocket().connect).toHaveBeenCalled());

    act(() => latestSocket().fire('connect'));
    expect(queryClient.getQueryState(queryKeys.appointments.list({}))?.isInvalidated).toBe(false);

    act(() => latestSocket().fire('disconnect', 'transport close'));
    act(() => latestSocket().fire('connect'));
    expect(queryClient.getQueryState(queryKeys.appointments.list({}))?.isInvalidated).toBe(true);
  });

  it('tears the socket down on sign-out', async () => {
    const { wrapper } = setup();
    const view = render(<div />, { wrapper });
    await waitFor(() => expect(latestSocket().connect).toHaveBeenCalled());
    const socket = latestSocket();

    view.unmount();

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.listeners.size).toBe(0);
  });
});

describe('useRealtimeEvent', () => {
  it('delivers typed payloads and always calls the latest handler', async () => {
    const { wrapper } = setup();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ handler }) => useRealtimeEvent(SOCKET_EVENTS.ASSISTANT_TYPING, handler),
      { wrapper, initialProps: { handler: first } },
    );
    await waitFor(() => expect(latestSocket().count(SOCKET_EVENTS.ASSISTANT_TYPING)).toBe(1));

    rerender({ handler: second });
    act(() => latestSocket().fire(SOCKET_EVENTS.ASSISTANT_TYPING, { sessionId: 's1', typing: true }));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ sessionId: 's1', typing: true });
    // Swapping the handler must not stack up listeners.
    expect(latestSocket().count(SOCKET_EVENTS.ASSISTANT_TYPING)).toBe(1);
  });

  it('removes its listener on unmount', async () => {
    const { wrapper } = setup();
    const { unmount } = renderHook(() => useRealtimeEvent(SOCKET_EVENTS.ASSISTANT_TURN, vi.fn()), { wrapper });
    await waitFor(() => expect(latestSocket().count(SOCKET_EVENTS.ASSISTANT_TURN)).toBe(1));
    const socket = latestSocket();

    unmount();

    expect(socket.count(SOCKET_EVENTS.ASSISTANT_TURN)).toBe(0);
  });
});
