import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { assertApiError } from '../helpers/assertions.js';
import { SEED } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient } from '../helpers/apiClient.js';

/**
 * Behaviour that only exists when NODE_ENV=production: nothing internal in an
 * error response, Secure cookies, and trusted reverse proxies — two of them,
 * as in the documented deployment (render.yaml: TRUST_PROXY_HOPS=2).
 *
 * Rate limiting is left on here because the proxy test needs it; the other
 * tests in this file make too few requests to trip it.
 */
describe('production mode', () => {
  let app: TestApp;
  let customer: ApiClient;

  before(async () => {
    app = await startTestApp({ env: { NODE_ENV: 'production', RATE_LIMIT_DISABLED: 'false', TRUST_PROXY_HOPS: '2' } });
    customer = await app.loginAs('customer');
  });
  after(async () => {
    await app.stop();
  });

  describe('an unexpected error', () => {
    const fail = (error: Error) => mock.method(app.db, 'query', async () => { throw error; });

    it('becomes a generic 500 that reveals nothing about the cause', async () => {
      const failing = fail(
        Object.assign(new Error('relation "users_secret_audit" does not exist at character 42'), {
          code: '42P01',
          table: 'users_secret_audit',
          detail: 'Key (email)=(someone@example.test) already exists.',
        }),
      );
      try {
        const res = await customer.get('/api/services');
        const error = assertApiError(res, 500, 'INTERNAL');

        assert.deepEqual(Object.keys(res.body as object), ['error']);
        assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'requestId']);
        assert.equal(error.message, 'Something went wrong on our end');

        const wire = JSON.stringify(res.body);
        for (const leak of ['users_secret_audit', 'relation', 'character 42', 'someone@example.test', '42P01', 'debug', 'stack', 'node_modules', '.ts:', 'at ']) {
          assert.ok(!wire.includes(leak), `the response must not contain "${leak}"`);
        }
      } finally {
        failing.mock.restore();
      }
    });

    it('hides a genuine database failure too: a real missing-table error from Postgres, not a mock', async () => {
      await app.db.query('ALTER TABLE services RENAME TO services_gone_for_test');
      try {
        const res = await customer.get('/api/services');
        const error = assertApiError(res, 500, 'INTERNAL');
        assert.deepEqual(Object.keys(res.body as object), ['error']);
        assert.equal(error.message, 'Something went wrong on our end');
        assert.equal(res.headers.get('x-powered-by'), null);

        const wire = JSON.stringify(res.body);
        for (const leak of ['services', 'relation', 'SELECT', '42P01', 'debug', 'stack', 'node_modules', '.ts:', 'at ']) {
          assert.ok(!wire.includes(leak), `the response must not contain "${leak}"`);
        }
      } finally {
        await app.db.query('ALTER TABLE services_gone_for_test RENAME TO services');
      }
    });

    it('does not expose a constraint name when the database reports a unique violation', async () => {
      const failing = fail(
        Object.assign(new Error('duplicate key value violates unique constraint "users_business_email_key"'), {
          code: '23505',
          constraint: 'users_business_email_key',
        }),
      );
      try {
        const res = await customer.get('/api/services');
        const error = assertApiError(res, 409, 'CONFLICT');
        assert.ok(!JSON.stringify(res.body).includes('users_business_email_key'));
        assert.equal(error.message, 'That value is already in use');
      } finally {
        failing.mock.restore();
      }
    });

    it('does not turn an expected failure into a 500, or hide its helpful message', async () => {
      const notFound = await customer.get('/api/appointments/99999999-9999-4999-8999-999999999999');
      assert.equal(assertApiError(notFound, 404, 'NOT_FOUND').message, 'Appointment not found');
      const invalid = await customer.post('/api/appointments', {});
      assert.ok(assertApiError(invalid, 400, 'VALIDATION_FAILED').details?.serviceId);
    });
  });

  describe('session cookies', () => {
    it('are marked Secure, so a browser never sends them over plain HTTP', async () => {
      const res = await app.client().login(SEED.users.staff.email, SEED.password);
      assert.equal(res.status, 200);
      assert.equal(res.setCookies.length, 2);
      for (const header of res.setCookies) {
        assert.match(header, /; Secure/i);
        assert.match(header, /; HttpOnly/i);
        assert.match(header, /; SameSite=Lax/i);
      }
    });

    it('are cleared with the same attributes they were set with, or the browser keeps them', async () => {
      const client = await app.loginAs('staff');
      const res = await client.post('/api/auth/logout');
      const access = res.setCookies.find((c) => c.startsWith('appt_access='))!;
      const refresh = res.setCookies.find((c) => c.startsWith('appt_refresh='))!;
      assert.match(access, /Path=\/;/);
      assert.match(refresh, /Path=\/api\/auth;/);
      for (const header of [access, refresh]) {
        assert.match(header, /Secure/i);
        assert.match(header, /Expires=Thu, 01 Jan 1970/);
      }
    });
  });

  describe('behind the Vercel rewrite and Render’s edge', () => {
    /**
     * The browser's request reaches Express through two proxies. Vercel puts
     * the client's address in X-Forwarded-For; Render's edge appends the
     * address it received from, which is Vercel's egress. (Render's own hop is
     * the socket peer, here 127.0.0.1.)
     */
    const VERCEL_EGRESS = '76.76.21.9';

    // Cheap requests that still count against the limiter: it counts every
    // response with a status of 400 or more, and an empty body is rejected
    // long before bcrypt is involved.
    const rejected = (forwardedFor: string) =>
      app.client().post('/api/auth/login', {}, { headers: { 'x-forwarded-for': forwardedFor } });

    it('counts the browser’s address, so clients behind the same Vercel egress have budgets of their own', async () => {
      for (let i = 1; i <= 10; i += 1) {
        assertApiError(await rejected(`203.0.113.9, ${VERCEL_EGRESS}`), 400, 'VALIDATION_FAILED');
      }
      assertApiError(await rejected(`203.0.113.9, ${VERCEL_EGRESS}`), 429, 'RATE_LIMITED');

      // With one trusted hop both would be keyed on Vercel's address and share
      // a budget, so one person's failed logins would lock everyone out.
      assertApiError(await rejected(`203.0.113.10, ${VERCEL_EGRESS}`), 400, 'VALIDATION_FAILED');
    });

    it('cannot be evaded by prepending addresses to X-Forwarded-For', async () => {
      // Each proxy appends what it saw, so only the last two entries are
      // trustworthy; anything before them is the client's own claim.
      for (const forged of [`198.51.100.1, 203.0.113.9, ${VERCEL_EGRESS}`, `198.51.100.2, 192.0.2.5, 203.0.113.9, ${VERCEL_EGRESS}`]) {
        assertApiError(await rejected(forged), 429, 'RATE_LIMITED');
      }
    });
  });
});
