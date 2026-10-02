import { ERROR_CODES, type ApiErrorBody, type AuthResponse } from '@appt/shared';
import { ApiError, type ClientErrorCode } from './errors';
import { setSessionHint } from './session-hint';
import { setAccessToken } from './token-store';

/**
 * Typed fetch wrapper for the Slotly API.
 *
 * Requests go to `/api/*` on the web app's own origin, which Next.js proxies to
 * the API (see next.config.mjs). That keeps the httpOnly auth cookies
 * first-party: no CORS preflights, no SameSite=None.
 */
const API_BASE = '/api';
/** Above the API's own AI timeout + retry, so a slow-but-working chat turn is not cut off. */
const DEFAULT_TIMEOUT_MS = 30_000;

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Serialised as JSON. */
  body?: unknown;
  /** Null/undefined entries are skipped. */
  query?: Record<string, QueryValue>;
  /** Cancels the request; React Query passes its own so unmounted views stop fetching. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

const sessionExpiredHandlers = new Set<() => void>();
let sessionExpiredNotified = false;

/**
 * Register a callback for "the session is gone and cannot be renewed".
 * The AuthProvider uses this to clear state and send the user to /login.
 * Returns an unsubscribe function.
 */
export function onSessionExpired(handler: () => void): () => void {
  sessionExpiredHandlers.add(handler);
  return () => {
    sessionExpiredHandlers.delete(handler);
  };
}

function notifySessionExpired(): void {
  // Several in-flight requests can fail at once; the app needs to hear about it once.
  if (sessionExpiredNotified) return;
  sessionExpiredNotified = true;
  sessionExpiredHandlers.forEach((handler) => handler());
}

/** Record a successful login/signup/refresh: remember the token and re-arm expiry notification. */
export function adoptSession(auth: AuthResponse): AuthResponse {
  sessionExpiredNotified = false;
  setAccessToken(auth.accessToken);
  setSessionHint(true);
  return auth;
}

/** Forget everything about the current session on this device. */
export function clearSession(): void {
  setAccessToken(null);
  setSessionHint(false);
}

/**
 * Did this error end the session for good? A 401 from the refresh endpoint
 * does — except SESSION_SUPERSEDED, which only means another tab rotated the
 * same cookie a moment earlier and the browser already holds its successor.
 */
export function isSessionEnded(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code !== ERROR_CODES.SESSION_SUPERSEDED;
}

/**
 * Retries after SESSION_SUPERSEDED. Each loss means another tab rotated the
 * cookie first, so the browser already holds a newer one: presenting it again
 * is correct. The wait grows and is jittered so several tabs that lost the same
 * race spread out instead of colliding in lockstep; the attempt cap keeps a
 * pathological case bounded (the error then surfaces as transient, never as a
 * sign-out).
 */
const SUPERSEDED_MAX_ATTEMPTS = 4;
const SUPERSEDED_BASE_DELAY_MS = 150;

const supersededRetryDelay = (attempt: number) =>
  SUPERSEDED_BASE_DELAY_MS * 2 ** attempt + Math.random() * SUPERSEDED_BASE_DELAY_MS;

async function refreshWithRetry(): Promise<AuthResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await execute<AuthResponse>('/auth/refresh', { method: 'POST' });
    } catch (error) {
      const superseded = error instanceof ApiError && error.code === ERROR_CODES.SESSION_SUPERSEDED;
      if (!superseded || attempt + 1 >= SUPERSEDED_MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, supersededRetryDelay(attempt)));
    }
  }
}

/**
 * Serialise refreshes across every tab of this origin with the Web Locks API.
 * Holding the lock while rotating means the next tab only reads the cookie
 * after the previous rotation's Set-Cookie has landed, so cross-tab races are
 * prevented rather than recovered from. Browsers without navigator.locks fall
 * back to the retry loop above, which the server's grace window makes safe.
 */
const REFRESH_LOCK = 'slotly:auth-refresh';

async function requestRefresh(): Promise<AuthResponse> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return refreshWithRetry();
  // The lock's promise resolves to the callback's return value (lib.dom types it as nested).
  return locks.request(REFRESH_LOCK, () => refreshWithRetry());
}

let refreshInFlight: Promise<AuthResponse> | null = null;

/**
 * POST /api/auth/refresh, single-flight.
 *
 * Refresh tokens rotate: each use invalidates the previous one. If two callers
 * in this tab refreshed concurrently with the same cookie, the loser would
 * present a just-rotated token. Sharing one in-flight promise makes that race
 * impossible — including the double mount React StrictMode causes in
 * development.
 *
 * Other tabs share the cookie but not this promise; they are serialised by a
 * Web Lock instead (see requestRefresh). Where locks are unavailable the server
 * answers a losing tab with SESSION_SUPERSEDED and it retries with the cookie
 * the winner left behind. If every retry loses, the error is passed on as
 * transient: the session is still alive.
 *
 * A 401 that ends the session clears local session state. Network and server
 * errors are transient and leave it alone.
 */
export function refreshSession(): Promise<AuthResponse> {
  refreshInFlight ??= requestRefresh()
    .then(adoptSession)
    .catch((error: unknown) => {
      if (isSessionEnded(error)) clearSession();
      throw error;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/**
 * Refresh on behalf of a request that was rejected as unauthenticated. If the
 * session is definitively over, announce it so the app can leave the page.
 */
export async function renewSession(): Promise<AuthResponse> {
  try {
    return await refreshSession();
  } catch (error) {
    if (isSessionEnded(error)) notifySessionExpired();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

function networkError(timedOut: boolean): ApiError {
  return new ApiError({
    status: 0,
    code: 'NETWORK',
    message: timedOut
      ? 'The server took too long to respond. Please try again.'
      : "We couldn't reach the server. Check your connection and try again.",
  });
}

/** fetch() with a timeout and network failures mapped to ApiError(NETWORK). */
async function send(path: string, options: RequestOptions): Promise<Response> {
  const { method = 'GET', body, query, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  // One controller merges the caller's cancellation with our timeout.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    return await fetch(buildUrl(path, query), {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    // A caller-initiated abort is not a failure to report; let it propagate untouched.
    if (signal?.aborted) throw error;
    throw networkError(timedOut);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  const error = (value as ApiErrorBody | null)?.error;
  return typeof error?.code === 'string' && typeof error.message === 'string';
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const at = Date.parse(header); // the header may also be an HTTP date
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

const TOO_LARGE_MESSAGE = 'That was too much to send at once. Shorten it and try again.';

function fallbackError(status: number): { code: ClientErrorCode; message: string } {
  if (status === 401) return { code: ERROR_CODES.UNAUTHENTICATED, message: 'Please sign in to continue.' };
  if (status === 403) return { code: ERROR_CODES.FORBIDDEN, message: 'You do not have access to this.' };
  if (status === 404) return { code: ERROR_CODES.NOT_FOUND, message: 'We could not find what you were looking for.' };
  if (status === 413) return { code: ERROR_CODES.PAYLOAD_TOO_LARGE, message: TOO_LARGE_MESSAGE };
  if (status === 429) return { code: ERROR_CODES.RATE_LIMITED, message: 'Too many requests. Please slow down.' };
  if (status >= 500) {
    return { code: ERROR_CODES.INTERNAL, message: 'The service is temporarily unavailable. Please try again in a moment.' };
  }
  return { code: 'UNKNOWN', message: 'Something went wrong. Please try again.' };
}

/**
 * Build an ApiError from a failed response. Anything that is not our error
 * envelope — an HTML page from a proxy, an empty 502 while the API restarts —
 * still becomes a well-formed ApiError with a friendly message, so callers
 * never have to handle a raw parse failure.
 */
async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = undefined;
  }
  const envelope = isErrorBody(body) ? body.error : undefined;
  const fallback = fallbackError(res.status);
  // The server's code is trusted to be one of ERROR_CODES; the UI treats unknown ones generically.
  const code = (envelope?.code as ClientErrorCode | undefined) ?? fallback.code;
  return new ApiError({
    status: res.status,
    code,
    // The server's wording for an oversized body ("The request body is too
    // large") describes the transport, not anything the person did, and a
    // proxy may answer 413 without an envelope at all. Either way it reads the same.
    message: code === ERROR_CODES.PAYLOAD_TOO_LARGE ? TOO_LARGE_MESSAGE : (envelope?.message ?? fallback.message),
    details: envelope?.details,
    requestId: envelope?.requestId ?? res.headers.get('x-request-id') ?? undefined,
    retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after')),
  });
}

async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError({ status: res.status, ...fallbackError(500) });
  }
}

/** One attempt: send, then throw ApiError for any non-2xx. */
async function execute<T>(path: string, options: RequestOptions): Promise<T> {
  const res = await send(path, options);
  if (!res.ok) throw await toApiError(res);
  return parseBody<T>(res);
}

/** /auth/* endpoints authenticate with credentials or the refresh cookie, never the access token. */
const isAuthEndpoint = (path: string) => path.startsWith('/auth/');

/**
 * Perform an API request.
 *
 * On 401 UNAUTHENTICATED (the 15-minute access cookie lapsed) it renews the
 * session once and replays the request, so an expiring access token is
 * invisible to the user. A second 401 is returned as-is rather than looping.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await execute<T>(path, options);
  } catch (error) {
    const expired = error instanceof ApiError && error.code === ERROR_CODES.UNAUTHENTICATED;
    if (!expired || isAuthEndpoint(path)) throw error;
  }
  await renewSession();
  return execute<T>(path, options);
}
