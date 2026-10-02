import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SEED } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * CROSS_SITE_COOKIES=true is for deployments where the web app and the API sit
 * on different sites. Browsers only accept a SameSite=None cookie that is also
 * Secure, so the two settings have to move together.
 */
describe('cross-site cookie deployment', () => {
  let app: TestApp;

  before(async () => {
    app = await startTestApp({ env: { NODE_ENV: 'production', CROSS_SITE_COOKIES: 'true' } });
  });
  after(async () => {
    await app.stop();
  });

  it('issues SameSite=None; Secure session cookies', async () => {
    const res = await app.client().login(SEED.users.customer.email, SEED.password);
    assert.equal(res.status, 200);
    assert.equal(res.setCookies.length, 2);
    for (const header of res.setCookies) {
      assert.match(header, /; SameSite=None/i);
      assert.match(header, /; Secure/i);
      assert.match(header, /; HttpOnly/i);
    }
  });
});
