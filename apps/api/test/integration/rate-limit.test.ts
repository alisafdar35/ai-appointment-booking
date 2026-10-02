import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertApiError } from '../helpers/assertions.js';
import { SEED } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient } from '../helpers/apiClient.js';

/**
 * Rate limiting, which every other test file switches off.
 *
 * Counters live in memory for the life of the process, so the tests in this
 * file are ordered: each one starts from the state the previous one left. They
 * are in one file, with the limiter on, precisely so that dependency is
 * visible rather than accidental.
 *
 * All requests come from one address (127.0.0.1), so the per-IP limiters see a
 * single client. The chat and write limiters are keyed by user id instead,
 * which is what lets one user's flood leave another untouched.
 */
describe('rate limiting', () => {
  let app: TestApp;
  let customer: ApiClient;
  let staff: ApiClient;
  let owner: ApiClient;
  let leaver: ApiClient;

  before(async () => {
    app = await startTestApp({ env: { RATE_LIMIT_DISABLED: 'false' } });
    // Signed in up front: once the auth limiter trips, nobody can log in.
    [customer, staff, owner, leaver] = await Promise.all([
      app.loginAs('customer'),
      app.loginAs('staff'),
      app.loginAs('owner'),
      app.loginAs('northsideOwner'),
    ]);
  });
  after(async () => {
    await app.stop();
  });

  const wrongLogin = (headers: Record<string, string> = {}) =>
    app.client().post('/api/auth/login', { email: SEED.users.customer.email, password: 'Wrong-Password-1' }, { headers });

  describe('login, signup and refresh', () => {
    it('does not count successful requests, so a legitimate user is never throttled', async () => {
      // Twelve successful refreshes: more than the limit of ten, and the last
      // two would have been rejected had successes been counted.
      for (let i = 1; i <= 12; i += 1) {
        assert.equal((await customer.post('/api/auth/refresh')).status, 200, `refresh ${i}`);
      }
      assert.equal((await app.client().login(SEED.users.owner.email, SEED.password)).status, 200);
    });

    it('lets ten failed logins through, and blocks the eleventh with 429 and a Retry-After', async () => {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        assertApiError(await wrongLogin(), 401, 'INVALID_CREDENTIALS');
      }

      const blocked = await wrongLogin();
      const error = assertApiError(blocked, 429, 'RATE_LIMITED');
      // A fifteen-minute lockout is stated in minutes, so the user can act on it.
      assert.match(error.message, /^Too many requests\. Try again in 1[45] minutes\.$/);

      const retryAfter = Number(blocked.headers.get('retry-after'));
      assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 15 * 60, `Retry-After: ${retryAfter}`);
      assert.ok(blocked.headers.get('ratelimit'), 'clients can see their budget');
      assert.match(blocked.headers.get('ratelimit-policy') ?? '', /10/);
    });

    it('keeps blocking, even for the correct password, until the window passes', async () => {
      const res = await app.client().login(SEED.users.customer.email, SEED.password);
      assertApiError(res, 429, 'RATE_LIMITED');
      assert.deepEqual(res.setCookies, [], 'a blocked login must not start a session');
    });

    it('applies the same budget to signup, which shares the credential-stuffing surface', async () => {
      const signup = await app.client().post('/api/auth/signup', {
        email: 'blocked@example.test',
        password: 'Sup3rSecretPass',
        fullName: 'Blocked Person',
      });
      assertApiError(signup, 429, 'RATE_LIMITED');
    });

    it('gives refresh a budget of its own, so a locked-out login does not end live sessions', async () => {
      assert.equal((await customer.post('/api/auth/refresh')).status, 200);
    });

    it('cannot be evaded by claiming a different address in X-Forwarded-For', async () => {
      // No proxy is trusted outside production, so the header is ignored and
      // the real socket address is what is counted.
      for (const forwarded of ['203.0.113.7', '198.51.100.23, 203.0.113.99', '2001:db8::1']) {
        assertApiError(await wrongLogin({ 'x-forwarded-for': forwarded }), 429, 'RATE_LIMITED');
      }
    });

    it('leaves the rest of the API available while the login endpoint is blocked', async () => {
      assert.equal((await customer.get('/api/appointments')).status, 200);
      assert.equal((await customer.get('/api/services')).status, 200);
      assert.equal((await app.client().get('/api/health')).status, 200);
      assert.equal((await leaver.post('/api/auth/logout')).status, 204, 'signing out must always be possible');
    });
  });

  describe('refresh', () => {
    const failedRefresh = () => app.client().post('/api/auth/refresh');

    it('answers failed refreshes from its own budget, even while login is blocked', async () => {
      assertApiError(await wrongLogin(), 429, 'RATE_LIMITED');
      for (let i = 1; i <= 5; i += 1) assertApiError(await failedRefresh(), 401, 'UNAUTHENTICATED');
    });

    it('counts every request, successful or not, and stops a runaway client at 60 per 5 minutes', async () => {
      // Already spent in this file: 13 successful refreshes and 5 failed ones.
      const spent = 13 + 5;
      let allowed = 0;
      for (;;) {
        const res = await failedRefresh();
        if (res.status === 429) {
          assertApiError(res, 429, 'RATE_LIMITED');
          assert.match(res.headers.get('ratelimit-policy') ?? '', /60/);
          break;
        }
        allowed += 1;
        assert.ok(allowed <= 60, 'the limiter never engaged');
      }
      assert.equal(allowed, 60 - spent, 'successes are counted along with failures');
    });
  });

  describe('chat', () => {
    const say = (client: ApiClient) => client.post('/api/chat/messages', { content: 'hello' });

    it('allows 20 messages a minute, then answers 429 with the standard envelope', async () => {
      for (let i = 1; i <= 20; i += 1) {
        assert.equal((await say(customer)).status, 201, `message ${i}`);
      }
      const blocked = await say(customer);
      assertApiError(blocked, 429, 'RATE_LIMITED');
      assert.ok(blocked.headers.get('retry-after'));
    });

    it('counts per user, not per address: one user’s flood leaves another untouched', async () => {
      // Same machine, same IP as the throttled customer above.
      assert.equal((await say(staff)).status, 201);
      assert.equal((await say(owner)).status, 201);
    });

    it('does not throttle the same user’s other requests', async () => {
      assert.equal((await customer.get('/api/appointments')).status, 200);
      assert.equal((await customer.get('/api/chat/sessions')).status, 200, 'reading history is not a model call');
    });
  });

  describe('writes', () => {
    it('allows 40 writes a minute per user, then answers 429', async () => {
      for (let i = 1; i <= 40; i += 1) {
        assert.equal((await owner.post('/api/chat/sessions')).status, 201, `write ${i}`);
      }
      assertApiError(await owner.post('/api/chat/sessions'), 429, 'RATE_LIMITED');
      assert.equal((await staff.post('/api/chat/sessions')).status, 201, 'another user has their own budget');
    });

    it('keeps chat and writes in separate budgets', async () => {
      // The owner has just exhausted the write limit but has used one chat message.
      assert.equal((await owner.post('/api/chat/messages', { content: 'still here' })).status, 201);
    });
  });
});
