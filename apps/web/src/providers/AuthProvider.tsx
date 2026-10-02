'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LoginInput, SignupInput, UserDto } from '@appt/shared';
import { authApi, hasSessionHint, isSessionEnded, onSessionExpired } from '@/lib/api';
import { clearInterruptedDrafts } from '@/lib/interrupted-drafts';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/**
 * How the page-load session check is going, while `status` is "loading".
 *   checking     the usual case: settles in well under a second
 *   waking       slower than SLOW_NOTICE_MS, or retrying: the API host is probably starting up
 *   unreachable  every attempt in the budget failed without the server saying "signed out"
 */
export type RestoreProgress = 'checking' | 'waking' | 'unreachable';

/** Attempts at restoring the session before offering a manual retry. */
export const RESTORE_ATTEMPTS = 3;
/** Total time the attempts may take; a free-tier host can need 30-60 s to wake. */
export const RESTORE_BUDGET_MS = 90_000;
/** The first attempt gets most of it: abandoning a refresh the server may still complete risks a replay. */
const FIRST_ATTEMPT_TIMEOUT_MS = 60_000;
const MIN_ATTEMPT_TIMEOUT_MS = 10_000;
const RESTORE_BACKOFF_MS = [2_000, 5_000] as const;
/** After this long, the loading screen explains the wait. */
export const SLOW_NOTICE_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Why the user is signed out: lets the route guard decide whether to remember where they were. */
export type SessionEnd = 'signed-out' | 'expired' | null;

interface AuthState {
  status: AuthStatus;
  user: UserDto | null;
  sessionEnd: SessionEnd;
}

export interface AuthContextValue extends AuthState {
  restore: RestoreProgress;
  /** Start the page-load session check again (after it ran out of attempts). */
  retryRestore: () => void;
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
  const [restore, setRestore] = useState<RestoreProgress>('checking');
  const [restoreRun, setRestoreRun] = useState(0);

  useEffect(() => {
    // Nothing to restore for a browser that has never signed in.
    if (!hasSessionHint()) {
      setState(signedOut(null));
      return;
    }
    let cancelled = false;
    setRestore('checking');
    const slowNotice = setTimeout(() => setRestore((current) => (current === 'checking' ? 'waking' : current)), SLOW_NOTICE_MS);
    const deadline = Date.now() + RESTORE_BUDGET_MS;

    /**
     * Only a definitive 401 means "signed out". A timeout, a dropped
     * connection or a 5xx (the API host waking from sleep, a deploy) says
     * nothing about the session, so it is retried with backoff, and after the
     * budget the user gets a manual retry rather than a sign-in form they do
     * not need.
     */
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        const remaining = deadline - Date.now();
        const timeoutMs = Math.max(MIN_ATTEMPT_TIMEOUT_MS, Math.min(FIRST_ATTEMPT_TIMEOUT_MS, remaining));
        try {
          const { user } = await authApi.refresh({ timeoutMs });
          if (!cancelled) setState(signedIn(user));
          return;
        } catch (error) {
          if (cancelled) return;
          if (isSessionEnded(error)) {
            // This browser had a session and it has ended (expired, revoked, or
            // an invalid cookie): the sign-in page says so.
            setState(signedOut('expired'));
            return;
          }
          const wait = RESTORE_BACKOFF_MS[attempt] ?? 0;
          if (attempt + 1 >= RESTORE_ATTEMPTS || Date.now() + wait >= deadline) {
            setRestore('unreachable');
            return;
          }
          setRestore('waking');
          await sleep(wait);
          if (cancelled) return;
        }
      }
    };
    void run().finally(() => clearTimeout(slowNotice));
    return () => {
      cancelled = true;
      clearTimeout(slowNotice);
    };
  }, [restoreRun]);

  const retryRestore = useCallback(() => setRestoreRun((run) => run + 1), []);

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
    // Work kept for a re-login after an expiry is not wanted once the user chooses to leave.
    clearInterruptedDrafts();
    setState(signedOut('signed-out'));
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, restore, retryRestore, login, signup, logout }),
    [state, restore, retryRestore, login, signup, logout],
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
