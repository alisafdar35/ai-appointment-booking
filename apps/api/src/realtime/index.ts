import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  SOCKET_EVENTS,
  type AppointmentDto,
  type AssistantTurnDto,
  type AssistantTypingPayload,
} from '@appt/shared';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { verifyAccessToken } from '../lib/jwt.js';

/**
 * Real-time delivery.
 *
 * ---------------------------------------------------------------------------
 * Socket.IO as an enhancement, not a dependency
 * ---------------------------------------------------------------------------
 * Every feature works over plain REST. The socket adds live typing indicators
 * and pushes updates to a user's other open tabs. If it fails to connect — a
 * proxy that will not upgrade, a blocked port, a flaky network — the UI shows a
 * degraded badge and keeps working. Building it the other way round, with the
 * chat only functioning over a websocket, would make a transport problem look
 * like a broken product.
 *
 * ---------------------------------------------------------------------------
 * Rooms, and why one per user rather than per session
 * ---------------------------------------------------------------------------
 * Each socket joins a room named for its authenticated user id. Appointment
 * events are relevant across a user's whole session list, not just the
 * conversation they happen to have open, and a per-user room means the server
 * never has to track which tab is looking at what.
 *
 * Staff and owners also join `business:<id>`, because their dashboard lists the
 * whole tenant's bookings and must hear about a customer's new one. Membership
 * is decided from the role in the verified access token, never from anything
 * the client asks for, so a customer's socket is never in a tenant room and
 * cannot see another customer's events. Assistant turns go to `user:<id>` only.
 * There is no code path that broadcasts to everyone.
 *
 * ---------------------------------------------------------------------------
 * Socket lifetime is bounded by the access token
 * ---------------------------------------------------------------------------
 * The token is checked once, at the handshake. So that a socket cannot outlive
 * the credential that opened it, the server disconnects it when that token
 * expires, and the client reconnects with a fresh one; and when every session
 * of a user is revoked (logout everywhere, refresh-token replay) their sockets
 * are dropped at once. An access token itself stays valid until it expires (15
 * minutes by default): that window is the accepted cost of stateless JWTs.
 */

let io: Server | null = null;

const userRoom = (userId: string) => `user:${userId}`;
const businessRoom = (businessId: string) => `business:${businessId}`;
const TENANT_WIDE_ROLES = new Set(['owner', 'staff']);

export function initRealtime(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    path: '/socket.io',
    // The browser connects to the API directly here (not through the Next.js
    // proxy), because websocket upgrades do not survive that rewrite reliably.
    // So CORS must be explicit, and credentials are not used — the handshake
    // carries a token instead. See the auth middleware below.
    cors: { origin: env.corsOrigins, credentials: false },
    // Allow the long-poll fallback: some corporate proxies refuse upgrades
    // outright, and a chat that silently fails there is worse than a slow one.
    transports: ['websocket', 'polling'],
    pingTimeout: 20_000,
  });

  /**
   * Authenticate at the handshake, not per message.
   *
   * The token arrives in `handshake.auth.token` rather than a cookie: the
   * access cookie is httpOnly (deliberately — see middleware/auth.ts), so
   * client JavaScript cannot read it to attach here. The web app keeps the
   * access token in memory for exactly this purpose and re-acquires it from
   * /api/auth/refresh after a reload.
   *
   * Rejecting at the handshake means an unauthenticated socket never joins a
   * room and never receives an event.
   */
  io.use((socket, next) => {
    const token =
      (socket.handshake.auth as { token?: string } | undefined)?.token ??
      socket.handshake.headers.authorization?.replace(/^Bearer /, '');

    if (!token) {
      next(new Error('UNAUTHENTICATED'));
      return;
    }
    try {
      const claims = verifyAccessToken(token);
      socket.data.userId = claims.sub;
      socket.data.businessId = claims.bid;
      socket.data.role = claims.role;
      socket.data.expiresAt = claims.exp * 1000;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const { userId, businessId, role, expiresAt } = socket.data as {
      userId: string;
      businessId: string;
      role: string;
      expiresAt: number;
    };
    void socket.join(TENANT_WIDE_ROLES.has(role) ? [userRoom(userId), businessRoom(businessId)] : [userRoom(userId)]);
    logger.debug({ userId, socketId: socket.id }, 'Socket connected');

    // A server-side disconnect makes the client reconnect, presenting whatever
    // token it holds now; an expired one is refused at the handshake above.
    // (Capped at setTimeout's 32-bit limit, past which it would fire at once.)
    const remainingMs = Math.min(Math.max(0, expiresAt - Date.now()), 2 ** 31 - 1);
    const expiry = setTimeout(() => socket.disconnect(true), remainingMs);

    socket.on('disconnect', (reason) => {
      clearTimeout(expiry);
      logger.debug({ userId, socketId: socket.id, reason }, 'Socket disconnected');
    });
  });

  logger.info('Realtime gateway ready');
  return io;
}

/**
 * Emit helpers.
 *
 * Each is a no-op when the gateway is not running, so the REST handlers can
 * call them unconditionally. A server started without realtime (or a test)
 * does not need a different code path.
 */
export function emitAssistantTurn(userId: string, turn: AssistantTurnDto): void {
  io?.to(userRoom(userId)).emit(SOCKET_EVENTS.ASSISTANT_TURN, turn);
}

export function emitAssistantTyping(userId: string, payload: AssistantTypingPayload): void {
  io?.to(userRoom(userId)).emit(SOCKET_EVENTS.ASSISTANT_TYPING, payload);
}

/**
 * The typing indicator for one request: `start` when the assistant begins
 * working on a session, `stop` when the request ends however it ends. Holding
 * the session id here is what lets the route call `stop` from a `finally`
 * without knowing whether `start` was ever reached — a request rejected before
 * its session was resolved never showed an indicator, so it clears none.
 */
export function typingIndicator(userId: string): { start(sessionId: string): void; stop(): void } {
  let active: string | null = null;
  return {
    start(sessionId) {
      active = sessionId;
      emitAssistantTyping(userId, { sessionId, typing: true });
    },
    stop() {
      if (active === null) return;
      emitAssistantTyping(userId, { sessionId: active, typing: false });
      active = null;
    },
  };
}

/**
 * Appointment events go to the customer the appointment belongs to and to the
 * tenant's staff room. Socket.IO delivers once per socket across the listed
 * rooms, so a staff member booking for themselves is not told twice.
 */
const appointmentAudience = (businessId: string, appointment: AppointmentDto) => [
  userRoom(appointment.customer.id),
  businessRoom(businessId),
];

export function emitAppointmentCreated(businessId: string, appointment: AppointmentDto): void {
  io?.to(appointmentAudience(businessId, appointment)).emit(SOCKET_EVENTS.APPOINTMENT_CREATED, { appointment });
}

export function emitAppointmentUpdated(businessId: string, appointment: AppointmentDto): void {
  io?.to(appointmentAudience(businessId, appointment)).emit(SOCKET_EVENTS.APPOINTMENT_UPDATED, { appointment });
}

/** Drop every open socket of a user, after all of their sessions were revoked. */
export function disconnectUser(userId: string): void {
  io?.in(userRoom(userId)).disconnectSockets(true);
}

export async function closeRealtime(): Promise<void> {
  if (!io) return;
  await io.close();
  io = null;
}
