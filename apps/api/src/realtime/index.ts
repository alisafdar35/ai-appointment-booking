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
 * Real-time delivery, as an enhancement: every feature works over REST, and a
 * socket that cannot connect shows a degraded badge rather than a broken chat.
 *
 * Rooms: each socket joins `user:<id>` (events matter across a user's whole
 * session list, and the server never tracks which tab shows what). Staff and
 * owners also join `business:<id>` for the tenant dashboard. Membership comes
 * from the verified token's role, never from the client, and nothing
 * broadcasts to everyone.
 *
 * Lifetime: the token is checked at the handshake, so the server disconnects a
 * socket when that token expires and drops all of a user's sockets when their
 * sessions are revoked. The up-to-15-minute access-token window is the
 * accepted cost of stateless JWTs.
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
