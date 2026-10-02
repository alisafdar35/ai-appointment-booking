import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { assertApiError } from '../helpers/assertions.js';
import { SEED } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient } from '../helpers/apiClient.js';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('http layer', () => {
  let app: TestApp;
  let anon: ApiClient;

  before(async () => {
    app = await startTestApp();
    anon = app.client();
  });
  after(async () => {
    await app.stop();
  });

  describe('unknown routes', () => {
    it('answer with the error envelope and a request id, not an HTML page', async () => {
      const res = await anon.get('/api/does-not-exist');
      const error = assertApiError(res, 404, 'NOT_FOUND');
      assert.equal(error.message, 'Cannot GET /api/does-not-exist');
    });

    it('cover every method and path outside the API too', async () => {
      assertApiError(await anon.post('/nothing-here', {}), 404, 'NOT_FOUND');
      assertApiError(await anon.request('DELETE', '/api/appointments'), 401, 'UNAUTHENTICATED');
      assertApiError(await anon.get('/api/auth/nope'), 404, 'NOT_FOUND');
      assertApiError(await anon.get('/'), 404, 'NOT_FOUND');
    });
  });

  describe('request ids', () => {
    it('generates a UUID when the caller sends none, and returns it in the header and the error body', async () => {
      const res = await anon.get('/api/nope');
      const id = res.headers.get('x-request-id');
      assert.match(id ?? '', UUID_V4);
      assertApiError(res, 404, 'NOT_FOUND');
    });

    it('honours a well-formed inbound id so a trace survives a proxy hop', async () => {
      const res = await anon.get('/api/nope', { headers: { 'x-request-id': 'trace-abc_123.XYZ' } });
      assert.equal(res.headers.get('x-request-id'), 'trace-abc_123.XYZ');
      assert.equal(assertApiError(res, 404, 'NOT_FOUND').requestId, 'trace-abc_123.XYZ');
    });

    it('returns the id on successful responses as well', async () => {
      const res = await anon.get('/api/health', { headers: { 'x-request-id': 'health-check-0001' } });
      assert.equal(res.headers.get('x-request-id'), 'health-check-0001');
    });

    const garbage: [string, string][] = [
      ['too short', 'abc'],
      ['contains spaces', 'not a valid id at all'],
      ['contains markup', '<script>alert(1)</script>'],
      ['too long', 'a'.repeat(129)],
      ['contains a newline-like escape', 'abcdefgh%0d%0aSet-Cookie:x=1'],
    ];
    for (const [label, value] of garbage) {
      it(`replaces an inbound id that is ${label}, rather than echoing it`, async () => {
        const res = await anon.get('/api/nope', { headers: { 'x-request-id': value } });
        const id = res.headers.get('x-request-id');
        assert.notEqual(id, value);
        assert.match(id ?? '', UUID_V4);
      });
    }

    it('gives concurrent requests distinct ids', async () => {
      const ids = (await Promise.all(Array.from({ length: 5 }, () => anon.get('/api/nope')))).map((r) =>
        r.headers.get('x-request-id'),
      );
      assert.equal(new Set(ids).size, 5);
    });
  });

  describe('request bodies', () => {
    it('rejects malformed JSON with a 400 envelope, not a 500', async () => {
      const res = await anon.request('POST', '/api/auth/login', { rawBody: '{"email": "a@b.test", ' });
      const error = assertApiError(res, 400, 'VALIDATION_FAILED');
      assert.equal(error.message, 'The request body is not valid JSON');
    });

    it('does not echo the parser’s own message, which can quote the payload', async () => {
      const res = await anon.request('POST', '/api/auth/login', { rawBody: '{secret-token-value' });
      assert.ok(!JSON.stringify(res.body).includes('secret-token-value'));
      assert.ok(!JSON.stringify(res.body).includes('Unexpected token'));
    });

    it('rejects bodies that are valid JSON but not an object', async () => {
      for (const rawBody of ['null', '"text"', '42']) {
        assert.equal((await anon.request('POST', '/api/auth/login', { rawBody })).status, 400, rawBody);
      }
      assertApiError(await anon.request('POST', '/api/auth/login', { rawBody: '[]' }), 400, 'VALIDATION_FAILED');
    });

    it('rejects a body over 100kb with a 413 envelope', async () => {
      const rawBody = JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(150_000) });
      const res = await anon.request('POST', '/api/auth/login', { rawBody });
      const error = assertApiError(res, 413, 'PAYLOAD_TOO_LARGE');
      assert.equal(error.message, 'The request body is too large');
    });

    it('applies the same cap to authenticated endpoints', async () => {
      const customer = await app.loginAs('customer');
      const rawBody = JSON.stringify({ content: 'x'.repeat(200_000) });
      assertApiError(await customer.request('POST', '/api/chat/messages', { rawBody }), 413, 'PAYLOAD_TOO_LARGE');
    });

    it('accepts a body just under the cap and lets field validation decide', async () => {
      const rawBody = JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(95_000) });
      const error = assertApiError(await anon.request('POST', '/api/auth/login', { rawBody }), 400, 'VALIDATION_FAILED');
      assert.ok(error.details?.password, 'rejected by the password length rule, not by the size cap');
    });

    it('rejects an unsupported charset with a client error', async () => {
      const res = await anon.request('POST', '/api/auth/login', {
        rawBody: '{}',
        headers: { 'content-type': 'application/json; charset=iso-8859-1' },
      });
      assertApiError(res, 415, 'VALIDATION_FAILED');
    });

    it('ignores a body that is not declared as JSON, so validation reports the missing fields', async () => {
      const res = await anon.request('POST', '/api/auth/login', {
        rawBody: '{"email":"customer@bluewave.test","password":"Password123!"}',
        headers: { 'content-type': 'text/plain' },
      });
      const error = assertApiError(res, 400, 'VALIDATION_FAILED');
      assert.deepEqual(Object.keys(error.details ?? {}).sort(), ['email', 'password']);
    });
  });

  describe('request paths', () => {
    it('answer a malformed percent-encoding with a 400, not a 500', async () => {
      const customer = await app.loginAs('customer');
      assertApiError(await customer.get('/api/appointments/%E0%A4%A'), 400, 'VALIDATION_FAILED');
    });
  });

  describe('security headers and CORS', () => {
    it('sets baseline security headers and does not advertise the framework', async () => {
      const res = await anon.get('/api/health');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-powered-by'), null);
      assert.ok(res.headers.get('strict-transport-security'));
    });

    it('lets the configured web origin make credentialed requests and read the request id', async () => {
      const res = await anon.get('/api/health', { headers: { origin: ALLOWED_ORIGIN } });
      assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
      assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
      assert.match(res.headers.get('access-control-expose-headers') ?? '', /X-Request-Id/i);
      assert.match(res.headers.get('vary') ?? '', /Origin/i);
    });

    it('does not grant credentials to any other origin', async () => {
      for (const origin of ['https://evil.example', 'http://localhost:3001', 'http://localhost:3000.evil.example', 'null']) {
        const res = await anon.get('/api/health', { headers: { origin } });
        assert.equal(res.headers.get('access-control-allow-origin'), null, origin);
        assert.equal(res.headers.get('access-control-allow-credentials'), null, origin);
      }
    });

    it('never answers with a wildcard, which browsers refuse for credentialed requests anyway', async () => {
      const res = await anon.get('/api/health', { headers: { origin: 'https://anything.example' } });
      assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
    });

    it('answers a preflight from the web origin, and gives a stranger no permission', async () => {
      const preflight = (origin: string) =>
        anon.request('OPTIONS', '/api/appointments', {
          headers: {
            origin,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type',
          },
        });

      const allowed = await preflight(ALLOWED_ORIGIN);
      assert.equal(allowed.status, 204);
      assert.equal(allowed.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
      assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
      assert.match(allowed.headers.get('access-control-allow-methods') ?? '', /POST/);

      const stranger = await preflight('https://evil.example');
      assert.equal(stranger.headers.get('access-control-allow-origin'), null);
    });
  });

  describe('cross-site request forgery', () => {
    const credentials = { email: SEED.users.customer.email, password: SEED.password };
    const loginFrom = (origin?: string) =>
      app.client().post('/api/auth/login', credentials, origin ? { headers: { origin } } : {});

    it('refuses a state-changing request from a page on another origin, before it does anything', async () => {
      for (const origin of ['https://evil.example', 'http://localhost:3000.evil.example', 'null']) {
        const res = await loginFrom(origin);
        assertApiError(res, 403, 'FORBIDDEN');
        assert.deepEqual(res.setCookies, [], `${origin}: no session may be started`);
      }
    });

    it('covers every state-changing method, ahead of authentication', async () => {
      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        const res = await anon.request(method, '/api/appointments', { headers: { origin: 'https://evil.example' } });
        assertApiError(res, 403, 'FORBIDDEN');
      }
    });

    it('lets the web origin through, as the Next.js proxy forwards it', async () => {
      assert.equal((await loginFrom(ALLOWED_ORIGIN)).status, 200);
    });

    it('lets a request with no Origin through: curl and servers carry no ambient cookies', async () => {
      assert.equal((await loginFrom()).status, 200);
    });

    it('does not block reads, which change nothing', async () => {
      assert.equal((await anon.get('/api/health', { headers: { origin: 'https://evil.example' } })).status, 200);
    });
  });

  describe('health endpoint', () => {
    type Health = { status: string; db: string; aiProvider: string; uptimeSeconds: number };

    it('reports the database as up and which AI engine is serving', async () => {
      const res = await anon.get<Health>('/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.body.db, 'up');
      assert.equal(res.body.aiProvider, 'fallback-only', 'no MISTRAL_API_KEY is configured for this suite');
      assert.ok(Number.isInteger(res.body.uptimeSeconds) && res.body.uptimeSeconds >= 0);
    });

    it('is also served at /health for platform probes, and needs no authentication', async () => {
      const res = await anon.get<Health>('/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.db, 'up');
    });

    it('reports nothing about any tenant’s AI usage: that is behind an owner login', async () => {
      const { body } = await anon.get<Record<string, unknown>>('/health');
      assert.deepEqual(Object.keys(body).sort(), ['aiProvider', 'db', 'status', 'uptimeSeconds']);
    });

    it('reports 503 with db "down" when Postgres cannot be reached, without failing the request', async () => {
      const failing = mock.method(app.db, 'query', async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5433');
      });
      try {
        const res = await anon.get<Health>('/api/health');
        assert.equal(res.status, 503);
        assert.equal(res.body.status, 'degraded');
        assert.equal(res.body.db, 'down');
        assert.ok(!JSON.stringify(res.body).includes('ECONNREFUSED'), 'the cause belongs in the logs, not the probe response');
      } finally {
        failing.mock.restore();
      }
    });
  });

  describe('AI usage summary', () => {
    type Summary = {
      windowHours: number;
      totalCalls: number;
      byOutcome: Record<string, number>;
      byProvider: Record<string, { calls: number; errorRate: number; p50LatencyMs: number | null; p95LatencyMs: number | null }>;
    };

    it('gives the owner their tenant’s calls, with latency percentiles per provider', async () => {
      // The seed holds four Bluewave interactions: mistral ok at 742ms and 915ms,
      // a mistral timeout at 8000ms, and the fallback answering in 3ms.
      const owner = await app.loginAs('owner');
      const res = await owner.get<{ summary: Summary }>('/api/ai/summary');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.summary, {
        windowHours: 24,
        totalCalls: 4,
        byOutcome: { ok: 3, timeout: 1 },
        byProvider: {
          // Percentiles of the model's own calls: the 3ms fallback must not drag them down.
          mistral: { calls: 3, errorRate: 0.333, p50LatencyMs: 915, p95LatencyMs: 8000 },
          fallback: { calls: 1, errorRate: 0, p50LatencyMs: 3, p95LatencyMs: 3 },
        },
      });
    });

    it('is scoped to the caller’s tenant', async () => {
      const northside = await app.loginAs('northsideOwner');
      const res = await northside.get<{ summary: Summary }>('/api/ai/summary');
      assert.equal(res.status, 200);
      assert.equal(res.body.summary.totalCalls, 0);
      assert.deepEqual(res.body.summary.byProvider, {});
    });

    it('is refused to customers and staff, and to anyone signed out', async () => {
      assertApiError(await (await app.loginAs('customer')).get('/api/ai/summary'), 403, 'FORBIDDEN');
      assertApiError(await (await app.loginAs('staff')).get('/api/ai/summary'), 403, 'FORBIDDEN');
      assertApiError(await anon.get('/api/ai/summary'), 401, 'UNAUTHENTICATED');
    });
  });

  describe('unexpected failures', () => {
    it('return the generic 500 envelope instead of the underlying error', async () => {
      const customer = await app.loginAs('customer');
      const failing = mock.method(app.db, 'query', async () => {
        throw new Error('relation "secret_internal_table" does not exist');
      });
      try {
        const res = await customer.get('/api/services');
        const error = assertApiError(res, 500, 'INTERNAL');
        assert.equal(error.message, 'Something went wrong on our end');
        assert.ok(!('stack' in error));
        assert.ok(!res.setCookies.length);
      } finally {
        failing.mock.restore();
      }
    });
  });
});
