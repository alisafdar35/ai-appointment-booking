'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { SOCKET_EVENTS } from '@appt/shared';
import { isSessionEnded, renewSession } from '@/lib/api';
import { queryKeys, upsertAppointmentInCaches } from '@/lib/queries';
import { createSocket, type RealtimeEvent, type RealtimeEventMap } from '@/lib/socket';
import { useAuth } from './AuthProvider';

/**
 * connecting  first attempt, or re-establishing after a drop
 * connected   live events are flowing
 * degraded    the last attempt failed; the app still works over REST and the
 *             socket keeps retrying in the background
 */
export type RealtimeStatus = 'connecting' | 'connected' | 'degraded';

interface RealtimeContextValue {
  status: RealtimeStatus;
  /** Null while signed out. */
  socket: Socket | null;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

/** How long to wait before retrying when a session refresh failed for a transient reason. */
const AUTH_RETRY_DELAY_MS = 10_000;

/**
 * Realtime as an enhancement, never a dependency.
 *
 * Every feature works over plain REST; the socket only adds live updates
 * (appointments changed in another tab, assistant turns). So a failure to
 * connect is reported as "degraded" and nothing else changes — there is no code
 * path in the app that waits on the socket.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, user } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const [socket, setSocket] = useState<Socket | null>(null);
  const userId = user?.id;

  useEffect(() => {
    // No session, no socket: the server rejects unauthenticated handshakes anyway.
    if (authStatus !== 'authenticated') return;

    const conn = createSocket();
    let hasConnectedBefore = false;
    let authRecoveryAttempted = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    setStatus('connecting');
    setSocket(conn);

    conn.on('connect', () => {
      authRecoveryAttempted = false;
      setStatus('connected');
      if (hasConnectedBefore) {
        // Events fired while we were offline are gone for good; refetch instead.
        void queryClient.invalidateQueries({ queryKey: queryKeys.appointments.all });
        void queryClient.invalidateQueries({ queryKey: queryKeys.chat.sessions() });
      }
      hasConnectedBefore = true;
    });

    conn.on('disconnect', (reason) => {
      if (reason === 'io client disconnect') return; // our own cleanup
      setStatus('connecting');
      // Socket.IO only auto-reconnects for transport failures; a deliberate
      // server-side disconnect needs a manual nudge.
      if (reason === 'io server disconnect') conn.connect();
    });

    conn.on('connect_error', (error) => {
      setStatus('degraded');
      // The handshake is rejected with UNAUTHENTICATED when the 15-minute access
      // token has expired (e.g. the laptop slept). Socket.IO does not retry
      // middleware rejections, so renew the session and reconnect ourselves —
      // once, to avoid looping if the server keeps refusing.
      if (error.message !== 'UNAUTHENTICATED' || authRecoveryAttempted) return;
      authRecoveryAttempted = true;
      renewSession()
        .then(() => conn.connect())
        .catch((refreshError: unknown) => {
          // A dead session was already announced by renewSession (and unmounts us).
          // Anything else is transient, so try the whole recovery again shortly.
          if (isSessionEnded(refreshError)) return;
          authRecoveryAttempted = false;
          retryTimer = setTimeout(() => conn.connect(), AUTH_RETRY_DELAY_MS);
        });
    });

    // Built-in handlers: keep the appointments caches current without a refetch.
    const onAppointment = ({ appointment }: RealtimeEventMap[typeof SOCKET_EVENTS.APPOINTMENT_CREATED]) =>
      upsertAppointmentInCaches(queryClient, appointment);
    conn.on(SOCKET_EVENTS.APPOINTMENT_CREATED, onAppointment);
    conn.on(SOCKET_EVENTS.APPOINTMENT_UPDATED, onAppointment);

    // Deferred a tick so React StrictMode's mount/unmount/mount in development
    // opens one connection instead of two (the first would be torn down mid-handshake).
    const connectTimer = setTimeout(() => conn.connect(), 0);

    return () => {
      clearTimeout(connectTimer);
      clearTimeout(retryTimer);
      conn.removeAllListeners();
      conn.disconnect();
      setSocket(null);
      setStatus('connecting');
    };
  }, [authStatus, userId, queryClient]);

  const value = useMemo(() => ({ status, socket }), [status, socket]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return context;
}

export function useRealtimeStatus(): RealtimeStatus {
  return useRealtime().status;
}

/**
 * Subscribe to a server-pushed event for the lifetime of the calling component.
 * The handler may change on every render without resubscribing; the listener is
 * removed on unmount and when the socket is replaced (e.g. after sign-out).
 */
export function useRealtimeEvent<E extends RealtimeEvent>(
  event: E,
  handler: (payload: RealtimeEventMap[E]) => void,
): void {
  const { socket } = useRealtime();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!socket) return;
    // The socket's listener types cannot express a generic event name; the
    // payload type is guaranteed by RealtimeEventMap at the hook's signature.
    const listener = (payload: unknown) => handlerRef.current(payload as RealtimeEventMap[E]);
    socket.on(event as string, listener);
    return () => {
      socket.off(event as string, listener);
    };
  }, [socket, event]);
}
