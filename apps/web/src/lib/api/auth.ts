import type { AuthResponse, LoginInput, SignupInput, UserDto } from '@appt/shared';
import { adoptSession, apiRequest, clearSession, refreshSession } from './client';

export const authApi = {
  /** Sets the auth cookies; the returned access token is kept in memory for the socket. */
  login: async (input: LoginInput): Promise<AuthResponse> =>
    adoptSession(await apiRequest<AuthResponse>('/auth/login', { method: 'POST', body: input })),

  /** Creates a new business unless `businessSlug` joins an existing one. */
  signup: async (input: SignupInput): Promise<AuthResponse> =>
    adoptSession(await apiRequest<AuthResponse>('/auth/signup', { method: 'POST', body: input })),

  /** Restore a session from the refresh cookie. Single-flight: concurrent callers share one request. */
  refresh: refreshSession,

  /**
   * Idempotent on the server. Local session state is cleared even if the
   * request fails: a user who clicked "sign out" must end up signed out here.
   */
  logout: async (options: { everywhere?: boolean } = {}): Promise<void> => {
    try {
      await apiRequest<void>('/auth/logout', {
        method: 'POST',
        query: { everywhere: options.everywhere || undefined },
      });
    } finally {
      clearSession();
    }
  },

  me: async (signal?: AbortSignal): Promise<UserDto> =>
    (await apiRequest<{ user: UserDto }>('/auth/me', { signal })).user,
};
