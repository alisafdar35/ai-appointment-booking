import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AuthResponse, UserDto } from '@appt/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, RESTORE_ATTEMPTS, SLOW_NOTICE_MS, useAuth } from './AuthProvider';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  hasSessionHint: vi.fn(),
  expire: { current: () => {} },
}));

vi.mock('@/lib/api', () => ({
  authApi: { refresh: mocks.refresh, login: mocks.login, signup: vi.fn(), logout: mocks.logout },
  hasSessionHint: mocks.hasSessionHint,
  isSessionEnded: (error: unknown) => {
    const { status, code } = (error ?? {}) as { status?: number; code?: string };
    return status === 401 && code !== 'SESSION_SUPERSEDED';
  },
  onSessionExpired: (handler: () => void) => {
    mocks.expire.current = handler;
    return () => {};
  },
}));

const user: UserDto = {
  id: 'u1',
  email: 'casey@example.test',
  fullName: 'Casey Customer',
  phone: null,
  role: 'customer',
  businessId: 'b1',
  businessName: 'Bluewave Dental',
  businessSlug: 'bluewave',
  businessTimezone: 'America/New_York',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const authResponse: AuthResponse = { user, accessToken: 'token', expiresInSeconds: 900 };

function setup() {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
  return { queryClient, ...renderHook(() => useAuth(), { wrapper }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.hasSessionHint.mockReturnValue(true);
});

describe('AuthProvider', () => {
  it('skips the network entirely for a browser that has never signed in', async () => {
    mocks.hasSessionHint.mockReturnValue(false);
    const { result } = setup();

    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('restores the session from the refresh cookie, showing "loading" until it settles', async () => {
    mocks.refresh.mockResolvedValue(authResponse);
    const { result } = setup();

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(result.current.user).toEqual(user);
  });

  it('signs out when the server definitively refuses the refresh (401)', async () => {
    mocks.refresh.mockRejectedValue(Object.assign(new Error('Sign in'), { status: 401, code: 'UNAUTHENTICATED' }));
    const { result } = setup();

    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    expect(result.current.user).toBeNull();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  describe('when the server is slow or unreachable on load (a free-tier host waking up)', () => {
    const network = () => Object.assign(new Error('timeout'), { status: 0, code: 'NETWORK' });
    const flush = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('gives the first attempt a long timeout, retries a timeout, and stays signed in when it succeeds', async () => {
      mocks.refresh.mockRejectedValueOnce(network()).mockResolvedValueOnce(authResponse);
      const { result } = setup();
      await flush(0);

      expect(mocks.refresh).toHaveBeenNthCalledWith(1, { timeoutMs: 60_000 });
      expect(result.current.status).toBe('loading');
      expect(result.current.restore).toBe('waking');

      await flush(5_000);
      expect(result.current.status).toBe('authenticated');
      expect(mocks.refresh).toHaveBeenCalledTimes(2);
    });

    it('explains the wait once it takes more than a few seconds', async () => {
      mocks.refresh.mockReturnValue(new Promise(() => {}));
      const { result } = setup();
      await flush(SLOW_NOTICE_MS - 1);
      expect(result.current.restore).toBe('checking');
      await flush(1);
      expect(result.current.restore).toBe('waking');
      expect(result.current.status).toBe('loading');
    });

    it('never signs out on repeated network or server errors: it offers a manual retry instead', async () => {
      mocks.refresh
        .mockRejectedValueOnce(network())
        .mockRejectedValueOnce(Object.assign(new Error('Bad gateway'), { status: 502, code: 'INTERNAL' }))
        .mockRejectedValueOnce(Object.assign(new Error('Lost the race'), { status: 401, code: 'SESSION_SUPERSEDED' }));
      const { result } = setup();
      await flush(20_000);

      expect(mocks.refresh).toHaveBeenCalledTimes(RESTORE_ATTEMPTS);
      expect(result.current.status).toBe('loading');
      expect(result.current.restore).toBe('unreachable');

      mocks.refresh.mockResolvedValueOnce(authResponse);
      act(() => result.current.retryRestore());
      await flush(0);
      expect(result.current.status).toBe('authenticated');
    });
  });

  it('treats a refused refresh on load as an ended session, so the sign-in page can say so', async () => {
    mocks.refresh.mockRejectedValue(Object.assign(new Error('Session expired'), { status: 401 }));
    const { result } = setup();

    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    expect(result.current.sessionEnd).toBe('expired');
  });

  it('forgets work kept for a re-login when the user signs out on purpose', async () => {
    mocks.refresh.mockResolvedValue(authResponse);
    mocks.logout.mockResolvedValue(undefined);
    window.sessionStorage.setItem('slotly.interrupted.booking-dialog', '{"userId":"u1"}');
    const { result } = setup();
    await waitFor(() => expect(result.current.status).toBe('authenticated'));

    await act(() => result.current.logout());

    expect(window.sessionStorage.getItem('slotly.interrupted.booking-dialog')).toBeNull();
  });

  it('signs in and out, clearing cached data on the way out', async () => {
    mocks.hasSessionHint.mockReturnValue(false);
    mocks.login.mockResolvedValue(authResponse);
    mocks.logout.mockResolvedValue(undefined);
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));

    await act(() => result.current.login({ email: user.email, password: 'Password123!' }));
    expect(result.current.status).toBe('authenticated');

    queryClient.setQueryData(['appointments'], ['private']);
    await act(() => result.current.logout());

    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.sessionEnd).toBe('signed-out');
    expect(queryClient.getQueryData(['appointments'])).toBeUndefined();
  });

  it('still signs out locally when the logout request fails', async () => {
    mocks.refresh.mockResolvedValue(authResponse);
    mocks.logout.mockRejectedValue(new Error('offline'));
    const { result } = setup();
    await waitFor(() => expect(result.current.status).toBe('authenticated'));

    await act(() => result.current.logout());

    expect(result.current.status).toBe('unauthenticated');
  });

  it('ends the session and clears the cache when the API client reports expiry', async () => {
    mocks.refresh.mockResolvedValue(authResponse);
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    queryClient.setQueryData(['appointments'], ['private']);

    act(() => mocks.expire.current());

    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.sessionEnd).toBe('expired');
    expect(queryClient.getQueryData(['appointments'])).toBeUndefined();
  });
});
