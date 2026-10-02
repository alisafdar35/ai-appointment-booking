import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SEED } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * Origins are compared as exact strings, and browsers send them without a
 * path. A CORS_ORIGINS entry pasted from the address bar ("…app/") must still
 * match, or every sign-in from the deployed web app is refused as cross-site.
 */
describe('CORS_ORIGINS entries pasted with a trailing slash', () => {
  const origin = 'https://slotly.example.app';
  let app: TestApp;

  before(async () => {
    app = await startTestApp({ env: { CORS_ORIGINS: `${origin}/, http://localhost:3000` } });
  });
  after(async () => {
    await app.stop();
  });

  it('accepts state-changing requests from the normalised origin', async () => {
    const res = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email: SEED.users.customer.email, password: SEED.password }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
  });

  it('still refuses an origin that is not listed', async () => {
    const res = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: SEED.users.customer.email, password: SEED.password }),
    });
    assert.equal(res.status, 403);
  });
});
