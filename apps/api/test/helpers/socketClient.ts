import { io, type Socket } from 'socket.io-client';
import { eventually } from './assertions.js';

/**
 * A Socket.IO connection that records everything it receives, so a test can
 * assert both "this event arrived" and "nothing else did".
 */
export interface Connection {
  socket: Socket;
  events: { name: string; payload: unknown }[];
  /** Resolve with the payload of the first event with this name. */
  waitFor<T = unknown>(name: string): Promise<T>;
  /** Events received so far, by name. */
  received(name: string): unknown[];
}

interface ConnectOptions {
  /** The handshake credential. Omit to connect without one. */
  token?: string | undefined;
  /** Send the credential as an Authorization header instead of handshake auth. */
  asHeader?: boolean;
  transports?: ('websocket' | 'polling')[];
}

const open = new Set<Socket>();

function create(baseUrl: string, options: ConnectOptions): Connection {
  const socket = io(baseUrl, {
    path: '/socket.io',
    transports: options.transports ?? ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 3000,
    ...(options.token && !options.asHeader ? { auth: { token: options.token } } : {}),
    ...(options.token && options.asHeader ? { extraHeaders: { authorization: `Bearer ${options.token}` } } : {}),
  });
  open.add(socket);

  const events: Connection['events'] = [];
  socket.onAny((name: string, payload: unknown) => events.push({ name, payload }));
  return {
    socket,
    events,
    waitFor: <T>(name: string) =>
      eventually(() => events.find((e) => e.name === name)?.payload as T | undefined),
    received: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
  };
}

/** Connect and wait for the server to accept the handshake. */
export function connect(baseUrl: string, options: ConnectOptions = {}): Promise<Connection> {
  const connection = create(baseUrl, options);
  return new Promise((resolve, reject) => {
    connection.socket.once('connect', () => resolve(connection));
    connection.socket.once('connect_error', (err) => reject(err));
  });
}

/** Connect and expect the handshake to be refused; resolves with the server's reason. */
export function connectExpectingRefusal(baseUrl: string, options: ConnectOptions = {}): Promise<string> {
  const connection = create(baseUrl, options);
  return new Promise((resolve, reject) => {
    connection.socket.once('connect', () => reject(new Error('the server accepted a handshake it should have refused')));
    connection.socket.once('connect_error', (err) => resolve(err.message));
  });
}

export function closeAllSockets(): void {
  for (const socket of open) socket.close();
  open.clear();
}
