'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LoginInput, SignupInput, UserDto } from '@appt/shared';
import { authApi, hasSessionHint, onSessionExpired } from '@/lib/api';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/** Why the user is signed out: lets the route guard decide whether to remember where they were. */
export type SessionEnd = 'signed-out' | 'expired' | null;

interface AuthState {
  status: AuthStatus;
  user: UserDto | null;
  sessionEnd: SessionEnd;
}

export interface AuthContextValue extends AuthState {
  login: (input: LoginInput) => Promise<UserDto>;
  signup: (input: SignupInput) => Promise<UserDto>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const LOADING: AuthState = { status: 'loading', user: null, sessionEnd: null };
const signedIn = (user: UserDto): AuthState => ({ status: 'authenticated', user, sessionEnd: null });
const signedOut = (sessionEnd: SessionEnd): AuthState => ({ status: 'unauthenticated', user: null, sessionEnd });

/**
 * Owns "who is signed in".
 *
 * No token is ever written to localStorage: the session lives in httpOnly
 * cookies (unreadable to scripts, so an XSS bug cannot steal it) and is
 * restored on load with POST /api/auth/refresh. `status` is "loading" until
 * that settles, so guards can show a skeleton instead of flashing the wrong
 * page.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>(LOADING);

  useEffect(() => {
    // Nothing to restore for a browser that has never signed in.
    if (!hasSessionHint()) {
      setState(signedOut(null));
      return;
    }
    let cancelled = false;
    authApi
      .refresh()
      .then(({ user }) => {
        if (!cancelled) setState(signedIn(user));
      })
      .catch(() => {
        // 401 means there is no valid session. Anything else (offline, API
        // restarting) also lands on the sign-in page, where submitting the form
        // surfaces the real problem with an actionable message.
        if (!cancelled) setState(signedOut(null));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      onSessionExpired(() => {
        // Cached data belongs to the previous session; keeping it would let the
        // next person to sign in on this device briefly see it.
        queryClient.clear();
        setState(signedOut('expired'));
      }),
    [queryClient],
  );

  const login = useCallback(async (input: LoginInput) => {
    const { user } = await authApi.login(input);
    setState(signedIn(user));
    return user;
  }, []);

  const signup = useCallback(async (input: SignupInput) => {
    const { user } = await authApi.signup(input);
    setState(signedIn(user));
    return user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Already signed out locally (authApi.logout clears state in a finally);
      // a failed network call must not leave the user stuck in the app.
    }
    queryClient.clear();
    setState(signedOut('signed-out'));
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, signup, logout }),
    [state, login, signup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/** The signed-in user. Only call below the AuthGuard, where a user is guaranteed. */
export function useCurrentUser(): UserDto {
  const { user } = useAuth();
  if (!user) throw new Error('useCurrentUser requires an authenticated session');
  return user;
}

/** IANA timezone of the signed-in user's business; UTC when signed out. Never the browser's zone. */
export function useBusinessTimezone(): string {
  return useAuth().user?.businessTimezone ?? 'UTC';
}
