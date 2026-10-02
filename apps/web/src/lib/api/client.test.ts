import type { AuthResponse } from '@appt/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptSession, apiRequest, clearSession, onSessionExpired, refreshSession } from './client';
import { ApiError } from './errors';
import { getAccessToken } from './token-store';

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const errorBody = (code: string, message = 'nope') => ({ error: { code, message, requestId: 'req-1' } });

const auth = (accessToken: string): AuthResponse => ({
  accessToken,
  expiresInSeconds: 900,
  user: {
    id: 'u1',
    email: 'a@b.test',
    fullName: 'A B',
    phone: null,
    role: 'customer',
    businessId: 'b1',
    businessName: 'Biz',
    businessSlug: 'biz',
    businessTimezone: 'America/New_York',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
});

const callsTo = (path: string) => fetchMock.mock.calls.filter(([url]) => url.startsWith(path));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  adoptSession(auth('initial')); // also re-arms the once-only expiry notification
  clearSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('responses', () => {
  it('parses JSON and sends credentials with JSON bodies', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await expect(apiRequest('/things', { method: 'POST', body: { a: 1 } })).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/things');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: '{"a":1}' });
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiRequest<void>('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('serialises query params and skips empty ones', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await apiRequest('/appointments', { query: { window: 'upcoming', status: undefined, limit: 5, x: null } });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/appointments?window=upcoming&limit=5');
  });
});

describe('errors', () => {
  it('maps the server error envelope onto ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'VALIDATION_FAILED', message: 'Bad input', details: { email: ['Required'] }, requestId: 'r-9' } }, 400),
    );
    const error = await apiRequest('/appointments', { method: 'POST', body: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'Bad input',
      details: { email: ['Required'] },
      requestId: 'r-9',
    });
  });

  it('turns a non-JSON error body (e.g. a proxy 502) into a friendly ApiError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }));
    const error = await apiRequest('/services').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 502, code: 'INTERNAL' });
    expect((error as ApiError).message).not.toContain('<html>');
  });

  it('reads Retry-After from rate-limit responses', async () => {
    fetchMock.mockResolvedValueOnce(json(errorBody('RATE_LIMITED'), 429, { 'retry-after': '12' }));
    await expect(apiRequest('/chat/messages', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 12,
    });
  });

  it('words an oversized body the same whether the API or a proxy refused it', async () => {
    fetchMock
      .mockResolvedValueOnce(json(errorBody('PAYLOAD_TOO_LARGE', 'The request body is too large'), 413))
      .mockResolvedValueOnce(new Response('<html>413 Request Entity Too Large</html>', { status: 413 }));

    for (let i = 0; i < 2; i += 1) {
      await expect(apiRequest('/chat/messages', { method: 'POST', body: {} })).rejects.toMatchObject({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'That was too much to send at once. Shorten it and try again.',
      });
    }
  });

  it('reports a network failure as NETWORK with a friendly message', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(apiRequest('/services')).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });

  it('lets a caller-initiated abort through untouched (it is not a failure to report)', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const error = await apiRequest('/services', { signal: controller.signal }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as DOMException).name).toBe('AbortError');
  });
});

describe('session renewal', () => {
  it('refreshes once on 401 UNAUTHENTICATED, stores the new token and replays the request', async () => {
    fetchMock
      .mockResolvedValueOnce(json(errorBody('UNAUTHENTICATED'), 401))
      .mockResolvedValueOnce(json(auth('fresh-token')))
      .mockResolvedValueOnce(json({ services: [] }));

    await expect(apiRequest('/services')).resolves.toEqual({ services: [] });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/services', '/api/auth/refresh', '/api/services']);
    expect(getAccessToken()).toBe('fresh-token');
  });

  it('sends extra headers (an Idempotency-Key) on the request and again on its replay after a refresh', async () => {
    fetchMock
      .mockResolvedValueOnce(json(errorBody('UNAUTHENTICATED'), 401))
      .mockResolvedValueOnce(json(auth('fresh-token')))
      .mockResolvedValueOnce(json({ appointment: { id: 'a1' } }, 201));

    await apiRequest('/appointments', { method: 'POST', body: {}, headers: { 'Idempotency-Key': 'attempt-1' } });

    const keys = callsTo('/api/appointments').map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys).toEqual(['attempt-1', 'attempt-1']);
  });

  it('never surfaces the server\'s debug detail or a proxy\'s stack trace page', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side.', debug: 'relation "users" does not exist' } }, 500),
    );
    const enveloped = await apiRequest('/services').catch((error: unknown) => error);
    expect(enveloped).toBeInstanceOf(ApiError);
    expect((enveloped as ApiError).message).toBe('Something went wrong on our side.');
    expect(JSON.stringify(enveloped)).not.toContain('relation');

    fetchMock.mockResolvedValueOnce(
      new Response('<pre>TypeError: x is undefined\n    at Object.<anonymous> (/srv/app/index.js:1:1)</pre>', { status: 500 }),
    );
    const raw = await apiRequest('/services').catch((error: unknown) => error);
    expect((raw as ApiError).message).toBe('The service is temporarily unavailable. Please try again in a moment.');
  });

  it('never ends the session over a data request that times out or hits a 5xx (a server waking up)', async () => {
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(new Response('', { status: 503 }));

    await expect(apiRequest('/appointments')).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(apiRequest('/appointments')).rejects.toMatchObject({ status: 503 });

    expect(callsTo('/api/auth/refresh')).toHaveLength(0);
    expect(expired).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('shares ONE refresh between concurrent requests (refresh tokens rotate)', async () => {
    let servicesCalls = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/auth/refresh') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return json(auth('shared'));
      }
      servicesCalls += 1;
      // The first three calls (before the refresh lands) are rejected; replays succeed.
      return servicesCalls <= 3 ? json(errorBody('UNAUTHENTICATED'), 401) : json({ ok: true });
    });

    await Promise.all([apiRequest('/services'), apiRequest('/services'), apiRequest('/services')]);

    expect(callsTo('/api/auth/refresh')).toHaveLength(1);
  });

  it('gives up after one retry rather than looping on a persistent 401', async () => {
    fetchMock.mockImplementation(async (url) =>
      url === '/api/auth/refresh' ? json(auth('t')) : json(errorBody('UNAUTHENTICATED'), 401),
    );
    await expect(apiRequest('/services')).rejects.toMatchObject({ status: 401 });
    expect(callsTo('/api/services')).toHaveLength(2);
    expect(callsTo('/api/auth/refresh')).toHaveLength(1);
  });

  it('announces session expiry exactly once when the refresh is rejected', async () => {
    const handler = vi.fn();
    const unsubscribe = onSessionExpired(handler);
    fetchMock.mockImplementation(async (url) =>
      url === '/api/auth/refresh' ? json(errorBody('UNAUTHENTICATED'), 401) : json(errorBody('UNAUTHENTICATED'), 401),
    );

    await Promise.allSettled([apiRequest('/services'), apiRequest('/appointments')]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
    unsubscribe();
  });

  it('does not announce expiry for a transient refresh failure', async () => {
    const handler = vi.fn();
    const unsubscribe = onSessionExpired(handler);
    fetchMock.mockImplementation(async (url) =>
      url === '/api/auth/refresh' ? json(errorBody('INTERNAL'), 503) : json(errorBody('UNAUTHENTICATED'), 401),
    );

    await expect(apiRequest('/services')).rejects.toMatchObject({ status: 503 });
    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('never tries to refresh for /auth endpoints (a wrong password is not an expired session)', async () => {
    fetchMock.mockResolvedValueOnce(json(errorBody('INVALID_CREDENTIALS'), 401));
    await expect(apiRequest('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a refresh another tab won (SESSION_SUPERSEDED)', () => {
  const superseded = () => json(errorBody('SESSION_SUPERSEDED', 'Your session was just refreshed in another tab'), 401);

  beforeEach(() => {
    vi.useFakeTimers();
    // The shortest jitter, so the timing assertions are exact.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits a moment, retries with the cookie the other tab left, and keeps the user signed in', async () => {
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);
    fetchMock.mockResolvedValueOnce(superseded()).mockResolvedValueOnce(json(auth('from-the-retry')));

    const refreshed = refreshSession();
    await vi.advanceTimersByTimeAsync(149);
    expect(callsTo('/api/auth/refresh')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(refreshed).resolves.toMatchObject({ accessToken: 'from-the-retry' });
    expect(callsTo('/api/auth/refresh')).toHaveLength(2);
    expect(getAccessToken()).toBe('from-the-retry');
    expect(expired).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('stays single-flight: concurrent requests share the one retried refresh', async () => {
    let servicesCalls = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/auth/refresh') return callsTo('/api/auth/refresh').length === 1 ? superseded() : json(auth('shared'));
      servicesCalls += 1;
      return servicesCalls <= 3 ? json(errorBody('UNAUTHENTICATED'), 401) : json({ ok: true });
    });

    const all = Promise.all([apiRequest('/services'), apiRequest('/services'), apiRequest('/services')]);
    await vi.advanceTimersByTimeAsync(150);

    await expect(all).resolves.toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(callsTo('/api/auth/refresh')).toHaveLength(2);
  });

  it('keeps retrying with growing delays while other tabs keep winning', async () => {
    fetchMock
      .mockResolvedValueOnce(superseded())
      .mockResolvedValueOnce(superseded())
      .mockResolvedValueOnce(json(auth('third-time-lucky')));

    const refreshed = refreshSession();
    await vi.advanceTimersByTimeAsync(150);
    expect(callsTo('/api/auth/refresh')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(callsTo('/api/auth/refresh')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(refreshed).resolves.toMatchObject({ accessToken: 'third-time-lucky' });
    expect(callsTo('/api/auth/refresh')).toHaveLength(3);
  });

  it('treats losing every attempt as transient: the request fails, but the session is not ended', async () => {
    adoptSession(auth('still-valid'));
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);
    fetchMock.mockImplementation(async (url) =>
      url === '/api/auth/refresh' ? superseded() : json(errorBody('UNAUTHENTICATED'), 401),
    );

    const request = apiRequest('/services').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(150 + 300 + 600);

    expect(await request).toMatchObject({ code: 'SESSION_SUPERSEDED' });
    expect(callsTo('/api/auth/refresh')).toHaveLength(4);
    expect(expired).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe('still-valid');
    unsubscribe();
  });

  it('does not retry a refresh token that is simply dead', async () => {
    fetchMock.mockResolvedValue(json(errorBody('UNAUTHENTICATED'), 401));
    await expect(refreshSession()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(callsTo('/api/auth/refresh')).toHaveLength(1);
  });
});

describe('cross-tab refresh serialisation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rotates the cookie while holding a Web Lock shared by every tab', async () => {
    const held: string[] = [];
    const request = vi.fn(async (name: string, callback: () => Promise<unknown>) => {
      held.push(name);
      try {
        return await callback();
      } finally {
        held.pop();
      }
    });
    vi.stubGlobal('navigator', { ...navigator, locks: { request } });
    let lockHeldDuringRefresh = false;
    fetchMock.mockImplementation(async () => {
      lockHeldDuringRefresh = held.includes('slotly:auth-refresh');
      return json(auth('locked'));
    });

    await expect(refreshSession()).resolves.toMatchObject({ accessToken: 'locked' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(lockHeldDuringRefresh).toBe(true);
  });
});
