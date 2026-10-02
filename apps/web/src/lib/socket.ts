import { io, type Socket } from 'socket.io-client';
import type { AppointmentDto, AssistantTurnDto, AssistantTypingPayload, SOCKET_EVENTS } from '@appt/shared';
import { getAccessToken } from './api/token-store';

/**
 * Payloads of the server-to-client events, keyed by event name. This is what
 * lets `useRealtimeEvent(SOCKET_EVENTS.ASSISTANT_TURN, turn => ...)` infer
 * `turn` instead of every handler casting an `unknown`.
 */
export interface RealtimeEventMap {
  [SOCKET_EVENTS.ASSISTANT_TYPING]: AssistantTypingPayload;
  [SOCKET_EVENTS.ASSISTANT_TURN]: AssistantTurnDto;
  [SOCKET_EVENTS.APPOINTMENT_CREATED]: { appointment: AppointmentDto };
  [SOCKET_EVENTS.APPOINTMENT_UPDATED]: { appointment: AppointmentDto };
}

export type RealtimeEvent = keyof RealtimeEventMap;

/** The browser connects to Socket.IO directly: websocket upgrades do not survive the Next.js rewrite. */
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? 'http://localhost:4000';

/**
 * Create (but do not connect) the realtime socket.
 *
 * `auth` is a function so every connection attempt, including automatic
 * reconnects, reads the *current* access token. A socket created with a
 * literal token would keep presenting it after it expired.
 */
export function createSocket(): Socket {
  return io(SOCKET_URL, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    auth: (callback) => callback({ token: getAccessToken() }),
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
    // A handshake that goes nowhere (a proxy that swallows the upgrade) would
    // otherwise sit at "connecting" for 20s before the UI admits it is degraded.
    timeout: 8_000,
  });
}
