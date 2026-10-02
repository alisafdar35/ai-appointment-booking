import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AuthResponse, UserDto } from '@appt/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthProvider';

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

  it('falls back to unauthenticated when the refresh fails', async () => {
    mocks.refresh.mockRejectedValue(new Error('401'));
    const { result } = setup();

    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    expect(result.current.user).toBeNull();
    expect(result.current.sessionEnd).toBeNull();
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
