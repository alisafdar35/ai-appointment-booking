import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import type { AuthResponse, ServiceDto } from '@appt/shared';
import { assertApiError, isUuid } from '../helpers/assertions.js';
import { SEED } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient } from '../helpers/apiClient.js';

const STRONG_PASSWORD = 'Sup3rSecretPass';
let emailCounter = 0;
const uniqueEmail = (label = 'user') => `${label}-${Date.now()}-${(emailCounter += 1)}@example.test`;

describe('auth', () => {
  let app: TestApp;

  before(async () => {
    app = await startTestApp();
  });
  after(async () => {
    await app.stop();
  });

  /** A brand-new customer of Bluewave, signed in. Isolates tests that revoke sessions. */
  async function freshCustomer(): Promise<ApiClient> {
    const client = app.client();
    const res = await client.post<AuthResponse>('/api/auth/signup', {
      email: uniqueEmail('fresh'),
      password: STRONG_PASSWORD,
      fullName: 'Fresh Customer',
      businessSlug: SEED.bluewave.slug,
    });
    assert.equal(res.status, 201);
    client.adopt(res.body);
    return client;
  }

  const refreshCookieOf = (client: ApiClient) => {
    const cookie = client.cookie('appt_refresh');
    assert.ok(cookie, 'client has no refresh cookie');
    return cookie.value;
  };

  /**
   * Move a user's past rotations outside the grace window, so presenting an old
   * token is judged as replay rather than as a sibling tab's lost race.
   */
  const ageRotations = (userId: string) =>
    app.db.query(
      `UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute'
       WHERE user_id = $1 AND replaced_by IS NOT NULL`,
      [userId],
    );

  const liveTokens = async (userId: string) =>
    (
      await app.db.query<{ live: number }>(
        'SELECT count(*)::int AS live FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      )
    ).rows[0]!.live;

  describe('signup', () => {
    it('creates a new tenant with the signer as owner when no business slug is given', async () => {
      const client = app.client();
      const email = uniqueEmail('owner');
      const res = await client.post<AuthResponse>('/api/auth/signup', {
        email,
        password: STRONG_PASSWORD,
        fullName: 'Olivia Owner',
        businessName: 'Acme Studio',
        phone: '+44 20 7946 0958',
      });

      assert.equal(res.status, 201);
      const { user, accessToken, expiresInSeconds } = res.body;
      assert.ok(isUuid(user.id));
      assert.equal(user.email, email);
      assert.equal(user.fullName, 'Olivia Owner');
      assert.equal(user.phone, '+44 20 7946 0958');
      assert.equal(user.role, 'owner');
      assert.equal(user.businessName, 'Acme Studio');
      assert.equal(user.businessSlug, 'acme-studio');
      assert.equal(user.businessTimezone, 'UTC');
      assert.notEqual(user.businessId, SEED.bluewave.id);
      assert.ok(accessToken);
      assert.equal(expiresInSeconds, 900);
      assert.equal('passwordHash' in user || 'password_hash' in user, false, 'the hash must never be serialised');
      assert.ok(client.cookie('appt_access'));
      assert.ok(client.cookie('appt_refresh'));
    });

    it('gives a new tenant a default service catalogue so booking works immediately', async () => {
      const client = app.client();
      const res = await client.post<AuthResponse>('/api/auth/signup', {
        email: uniqueEmail('catalogue'),
        password: STRONG_PASSWORD,
        fullName: 'Casey Catalogue',
        businessName: 'Catalogue Co',
      });
      assert.equal(res.status, 201);

      const services = await client.get<{ services: ServiceDto[] }>('/api/services');
      assert.equal(services.status, 200);
      assert.deepEqual(
        services.body.services.map((s) => s.name),
        ['Extended Session', 'Initial Consultation', 'Standard Appointment'],
      );
    });

    it('derives a readable slug from the business name and disambiguates collisions', async () => {
      const signUp = (businessName: string) =>
        app.client().post<AuthResponse>('/api/auth/signup', {
          email: uniqueEmail('slug'),
          password: STRONG_PASSWORD,
          fullName: 'Sam Slug',
          businessName,
        });

      const accented = await signUp('Café Déjà Vu!');
      assert.equal(accented.body.user.businessSlug, 'cafe-deja-vu');

      const first = await signUp('Collision Co');
      const second = await signUp('Collision Co');
      assert.equal(first.body.user.businessSlug, 'collision-co');
      assert.match(second.body.user.businessSlug, /^collision-co-[a-z0-9]{1,4}$/);
      assert.notEqual(first.body.user.businessId, second.body.user.businessId);
    });

    it('gives simultaneous signups with the same business name a workspace each', async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          app.client().post<AuthResponse>('/api/auth/signup', {
            email: uniqueEmail(`samename${i}`),
            password: STRONG_PASSWORD,
            fullName: 'Same Name',
            businessName: 'Rush Hour Dental',
          }),
        ),
      );
      assert.deepEqual(
        results.map((r) => r.status),
        [201, 201, 201, 201],
      );
      const slugs = results.map((r) => r.body.user.businessSlug);
      assert.equal(new Set(slugs).size, 4, `every tenant needs its own slug, got ${slugs.join(', ')}`);
      assert.ok(slugs.every((slug) => slug.startsWith('rush-hour-dental')));
    });

    it('names the workspace after the signer when no business name is given', async () => {
      const res = await app.client().post<AuthResponse>('/api/auth/signup', {
        email: uniqueEmail('anon'),
        password: STRONG_PASSWORD,
        fullName: 'Jane Doe',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.user.businessName, "Jane's Workspace");
      assert.equal(res.body.user.role, 'owner');
    });

    it('joins an existing tenant by slug as a customer', async () => {
      const res = await app.client().post<AuthResponse>('/api/auth/signup', {
        email: uniqueEmail('joiner'),
        password: STRONG_PASSWORD,
        fullName: 'Jo Joiner',
        businessSlug: SEED.bluewave.slug,
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.user.role, 'customer');
      assert.equal(res.body.user.businessId, SEED.bluewave.id);
      assert.equal(res.body.user.businessName, 'Bluewave Dental');
      assert.equal(res.body.user.businessTimezone, SEED.bluewave.timezone);
    });

    it('cannot be used to claim a role: joining always yields a customer', async () => {
      const res = await app.client().post<AuthResponse>('/api/auth/signup', {
        email: uniqueEmail('escalate'),
        password: STRONG_PASSWORD,
        fullName: 'Eve Escalate',
        businessSlug: SEED.bluewave.slug,
        role: 'owner',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.user.role, 'customer');
    });

    it('rejects an unknown business slug as a field error on the slug', async () => {
      const res = await app.client().post('/api/auth/signup', {
        email: uniqueEmail('lost'),
        password: STRONG_PASSWORD,
        fullName: 'Lost Lena',
        businessSlug: 'no-such-business',
      });
      const error = assertApiError(res, 400, 'VALIDATION_FAILED');
      assert.deepEqual(Object.keys(error.details ?? {}), ['businessSlug']);
    });

    it('rejects a duplicate email in the same tenant, whatever its case', async () => {
      const email = uniqueEmail('dupe');
      const body = { email, password: STRONG_PASSWORD, fullName: 'Dee Dupe', businessSlug: SEED.bluewave.slug };
      assert.equal((await app.client().post('/api/auth/signup', body)).status, 201);

      assertApiError(await app.client().post('/api/auth/signup', body), 409, 'EMAIL_TAKEN');
      assertApiError(
        await app.client().post('/api/auth/signup', { ...body, email: email.toUpperCase() }),
        409,
        'EMAIL_TAKEN',
      );
      // The seeded accounts are protected the same way.
      assertApiError(
        await app.client().post('/api/auth/signup', { ...body, email: SEED.users.customer.email }),
        409,
        'EMAIL_TAKEN',
      );
    });

    it('allows the same email in a different tenant', async () => {
      const email = uniqueEmail('twotenants');
      const join = (businessSlug: string) =>
        app.client().post<AuthResponse>('/api/auth/signup', {
          email,
          password: STRONG_PASSWORD,
          fullName: 'Two Tenants',
          businessSlug,
        });

      const bluewave = await join('bluewave');
      const northside = await join('northside');
      assert.equal(bluewave.status, 201);
      assert.equal(northside.status, 201);
      assert.notEqual(bluewave.body.user.id, northside.body.user.id);
      assert.equal(northside.body.user.businessSlug, 'northside');

      // ...and a brand-new tenant of their own, with an email that already exists elsewhere.
      const ownTenant = await app.client().post<AuthResponse>('/api/auth/signup', {
        email: SEED.users.customer.email,
        password: STRONG_PASSWORD,
        fullName: 'Marcus Again',
        businessName: 'Marcus Dental',
      });
      assert.equal(ownTenant.status, 201);
    });

    it('lets exactly one of several simultaneous signups with the same email win', async () => {
      const body = {
        email: uniqueEmail('race'),
        password: STRONG_PASSWORD,
        fullName: 'Rae Race',
        businessSlug: SEED.bluewave.slug,
      };
      const results = await Promise.all(Array.from({ length: 4 }, () => app.client().post('/api/auth/signup', body)));

      assert.equal(results.filter((r) => r.status === 201).length, 1);
      for (const loser of results.filter((r) => r.status !== 201)) assertApiError(loser, 409, 'EMAIL_TAKEN');

      const { rows } = await app.db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [body.email]);
      assert.equal(rows[0].n, 1);
    });

    it('needs only one database connection per signup, so a nearly exhausted pool cannot deadlock it', async () => {
      // A signup that held a connection while asking the pool for a second would
      // wait on itself forever once the pool had no spare — which a burst of
      // simultaneous signups the size of the pool produces on its own. Here the
      // pool is squeezed to a single free connection to make that deterministic.
      const squeezed = await Promise.all(Array.from({ length: 9 }, () => app.db.connect()));
      try {
        const startedAt = Date.now();
        const results = await Promise.all(
          Array.from({ length: 3 }, (_, i) =>
            app.client().post<AuthResponse>('/api/auth/signup', {
              email: uniqueEmail(`squeeze${i}`),
              password: STRONG_PASSWORD,
              fullName: `Squeeze ${i}`,
              ...(i % 2 === 0 ? { businessSlug: SEED.bluewave.slug } : { businessName: `Squeeze Co ${i}` }),
            }),
          ),
        );
        assert.deepEqual(
          results.map((r) => r.status),
          [201, 201, 201],
        );
        assert.ok(Date.now() - startedAt < 8000, 'the signups must not sit waiting for the pool to time out');
      } finally {
        for (const connection of squeezed) connection.release();
      }
    });

    it('rejects a weak password with the failing rules as field details', async () => {
      const res = await app.client().post('/api/auth/signup', {
        email: uniqueEmail('weak'),
        password: 'short',
        fullName: 'Wendy Weak',
      });
      const error = assertApiError(res, 400, 'VALIDATION_FAILED');
      assert.deepEqual(Object.keys(error.details ?? {}), ['password']);
      const messages = error.details!.password!;
      assert.ok(messages.includes('Must be at least 10 characters'));
      assert.ok(messages.includes('Must contain an uppercase letter'));
      assert.ok(messages.includes('Must contain a number'));
    });

    it('reports every invalid field at once, keyed by field name', async () => {
      const res = await app.client().post('/api/auth/signup', {
        email: 'not-an-email',
        password: 'alllowercase',
        fullName: '   ',
        phone: 'call me',
        businessSlug: 'Not A Slug',
      });
      const error = assertApiError(res, 400, 'VALIDATION_FAILED');
      assert.deepEqual(Object.keys(error.details ?? {}).sort(), [
        'businessSlug',
        'email',
        'fullName',
        'password',
        'phone',
      ]);
    });

    it('treats blank optional fields as absent, as an untouched form input arrives', async () => {
      const res = await app.client().post<AuthResponse>('/api/auth/signup', {
        email: uniqueEmail('blank'),
        password: STRONG_PASSWORD,
        fullName: 'Blank Fields',
        businessSlug: '',
        businessName: '   ',
        phone: '',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.user.role, 'owner', 'no slug means a new tenant');
      assert.equal(res.body.user.businessName, "Blank's Workspace");
    });

    it('treats an empty phone as absent rather than invalid', async () => {
      const res = await app.client().post<AuthResponse>('/api/auth/signup', {
        email: uniqueEmail('nophone'),
        password: STRONG_PASSWORD,
        fullName: 'No Phone',
        phone: '',
        businessSlug: SEED.bluewave.slug,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.user.phone, null);
    });

    it('normalises the email to lower case', async () => {
      const email = uniqueEmail('Mixed');
      const res = await app.client().post<AuthResponse>('/api/auth/signup', {
        email: `  ${email.toUpperCase()}  `,
        password: STRONG_PASSWORD,
        fullName: 'Mixed Case',
        businessSlug: SEED.bluewave.slug,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.user.email, email.toLowerCase());
    });
  });

  describe('login', () => {
    it('returns the user and an access token, and sets httpOnly session cookies', async () => {
      const client = app.client();
      const res = await client.login(SEED.users.customer.email, SEED.password);

      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, SEED.users.customer.id);
      assert.equal(res.body.user.role, 'customer');
      assert.equal(res.body.user.businessSlug, 'bluewave');
      assert.equal(res.body.expiresInSeconds, 900);
      assert.ok(res.body.accessToken);
      assert.equal('passwordHash' in res.body.user, false);

      const access = client.cookie('appt_access');
      assert.ok(access);
      assert.equal(access.httpOnly, true);
      assert.equal(access.sameSite, 'Lax');
      assert.equal(access.path, '/');
      assert.equal(access.maxAge, 900);
      assert.equal(access.secure, false, 'Secure is for production only; local HTTP would drop the cookie');
      assert.equal(access.value, res.body.accessToken);

      const refresh = client.cookie('appt_refresh');
      assert.ok(refresh);
      assert.equal(refresh.httpOnly, true);
      assert.equal(refresh.sameSite, 'Lax');
      assert.equal(refresh.path, '/api/auth', 'the refresh token must not travel with ordinary API calls');
      assert.ok(refresh.maxAge! >= 7 * 86_400 - 10 && refresh.maxAge! <= 7 * 86_400);
      assert.notEqual(refresh.value, access.value);
    });

    it('issues an access token carrying the identity and tenant the API authorises with', async () => {
      const res = await app.client().login(SEED.users.staff.email, SEED.password);
      const claims = jwt.decode(res.body.accessToken) as jwt.JwtPayload;
      assert.equal(claims.sub, SEED.users.staff.id);
      assert.equal(claims.bid, SEED.bluewave.id);
      assert.equal(claims.role, 'staff');
      assert.equal(claims.email, SEED.users.staff.email);
      assert.equal(claims.iss, 'appt-api');
      assert.equal(claims.exp! - claims.iat!, 900);
    });

    it('stores only a hash of the refresh token', async () => {
      const client = app.client();
      await client.login(SEED.users.owner.email, SEED.password);
      const token = refreshCookieOf(client);

      const { rows } = await app.db.query<{ token_hash: Buffer }>(
        'SELECT token_hash FROM refresh_tokens WHERE user_id = $1',
        [SEED.users.owner.id],
      );
      assert.ok(rows.length >= 1);
      for (const row of rows) assert.notEqual(row.token_hash.toString('utf8'), token);
    });

    it('ignores a blank tenant slug instead of looking for a business with no name', async () => {
      const res = await app.client().post<AuthResponse>('/api/auth/login', {
        email: SEED.users.customer.email,
        password: SEED.password,
        businessSlug: '',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, SEED.users.customer.id);
    });

    it('is case-insensitive about the email', async () => {
      const res = await app.client().login('Customer@BlueWave.TEST', SEED.password);
      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, SEED.users.customer.id);
    });

    it('answers a wrong password and an unknown email identically, so accounts cannot be enumerated', async () => {
      const wrongPassword = await app.client().login(SEED.users.customer.email, 'Wrong-Password-1');
      const unknownEmail = await app.client().login('nobody-at-all@example.test', 'Wrong-Password-1');

      const a = assertApiError(wrongPassword, 401, 'INVALID_CREDENTIALS');
      const b = assertApiError(unknownEmail, 401, 'INVALID_CREDENTIALS');
      assert.equal(a.message, b.message);
      assert.equal(a.details, undefined);
      assert.equal(b.details, undefined);
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
      assert.deepEqual(wrongPassword.setCookies, [], 'a failed login must not set a session');
    });

    it('does not reveal whether the account exists when the tenant hint is wrong', async () => {
      const res = await app.client().login(SEED.users.customer.email, SEED.password, 'northside');
      assertApiError(res, 401, 'INVALID_CREDENTIALS');
    });

    it('uses the tenant slug to pick the account when one email exists in two tenants', async () => {
      const email = uniqueEmail('shared');
      const otherPassword = 'An0therPassword!';
      const signUp = (businessSlug: string, password: string) =>
        app.client().post('/api/auth/signup', { email, password, fullName: 'Shared Person', businessSlug });
      assert.equal((await signUp('bluewave', STRONG_PASSWORD)).status, 201);
      assert.equal((await signUp('northside', otherPassword)).status, 201);

      const inNorthside = await app.client().login(email, otherPassword, 'northside');
      assert.equal(inNorthside.status, 200);
      assert.equal(inNorthside.body.user.businessSlug, 'northside');

      const inBluewave = await app.client().login(email, STRONG_PASSWORD, 'bluewave');
      assert.equal(inBluewave.status, 200);
      assert.equal(inBluewave.body.user.businessSlug, 'bluewave');

      // A password is only ever checked against the account the slug selects.
      assertApiError(await app.client().login(email, otherPassword, 'bluewave'), 401, 'INVALID_CREDENTIALS');
    });

    it('rejects a malformed body before touching credentials', async () => {
      const client = app.client();
      const missingPassword = await client.post('/api/auth/login', { email: SEED.users.customer.email });
      assert.deepEqual(Object.keys(assertApiError(missingPassword, 400, 'VALIDATION_FAILED').details ?? {}), ['password']);

      const badEmail = await client.post('/api/auth/login', { email: 'nope', password: 'x' });
      assert.deepEqual(Object.keys(assertApiError(badEmail, 400, 'VALIDATION_FAILED').details ?? {}), ['email']);
    });

    it('does not apply the signup password policy, so a tightened policy cannot lock anyone out', async () => {
      // "Password123!" is fine, but the point is the login schema only requires non-empty.
      const res = await app.client().login(SEED.users.customer.email, 'x');
      assertApiError(res, 401, 'INVALID_CREDENTIALS');
    });
  });

  describe('session endpoints', () => {
    it('GET /me requires authentication', async () => {
      assertApiError(await app.client().get('/api/auth/me'), 401, 'UNAUTHENTICATED');
    });

    it('GET /me returns the signed-in user using the cookie', async () => {
      const client = await app.loginAs('owner');
      const res = await client.get<{ user: { id: string; role: string; businessId: string } }>('/api/auth/me');
      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, SEED.users.owner.id);
      assert.equal(res.body.user.role, 'owner');
      assert.equal(res.body.user.businessId, SEED.bluewave.id);
    });

    it('accepts the access token as a Bearer header, with no cookies at all', async () => {
      const login = await app.client().login(SEED.users.customer.email, SEED.password);
      const res = await app.client().get<{ user: { id: string } }>('/api/auth/me', {
        bearer: login.body.accessToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, SEED.users.customer.id);
    });

    it('prefers a valid Bearer token over a cookie, and rejects an invalid one even when the cookie is fine', async () => {
      const client = await app.loginAs('customer');
      assertApiError(await client.get('/api/auth/me', { bearer: 'not-a-token' }), 401, 'UNAUTHENTICATED');
    });

    describe('token validation', () => {
      const secret = () => process.env.JWT_SECRET!;
      const claims = () => ({
        sub: SEED.users.customer.id,
        bid: SEED.bluewave.id,
        role: 'customer',
        email: SEED.users.customer.email,
      });
      const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

      const rejected: [string, () => string][] = [
        ['a token signed with a different secret', () => jwt.sign(claims(), 'x'.repeat(40), { issuer: 'appt-api' })],
        ['a token from a different issuer', () => jwt.sign(claims(), secret(), { issuer: 'someone-else' })],
        ['an expired token', () => jwt.sign({ ...claims(), exp: Math.floor(Date.now() / 1000) - 60 }, secret(), { issuer: 'appt-api' })],
        ['an unsigned (alg=none) token', () => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims(), iss: 'appt-api' })}.`],
        ['a token with no subject', () => jwt.sign({ bid: SEED.bluewave.id }, secret(), { issuer: 'appt-api' })],
        ['a token signed with a different algorithm', () => jwt.sign(claims(), secret(), { issuer: 'appt-api', algorithm: 'HS512' })],
      ];

      for (const [label, forge] of rejected) {
        it(`rejects ${label} with 401`, async () => {
          assertApiError(await app.client().get('/api/auth/me', { bearer: forge() }), 401, 'UNAUTHENTICATED');
        });
      }

      it('rejects a token whose payload was altered after signing', async () => {
        const login = await app.client().login(SEED.users.customer.email, SEED.password);
        const [header, , signature] = login.body.accessToken.split('.');
        // Same signature, but the payload now claims to be the owner.
        const forgedPayload = b64({ ...claims(), role: 'owner', iss: 'appt-api', exp: 4_000_000_000 });
        const res = await app.client().get('/api/auth/me', { bearer: `${header}.${forgedPayload}.${signature}` });
        assertApiError(res, 401, 'UNAUTHENTICATED');
      });

      it('says "expired" for an expired token so the client knows to refresh', async () => {
        const expired = jwt.sign({ ...claims(), exp: Math.floor(Date.now() / 1000) - 60 }, secret(), { issuer: 'appt-api' });
        const error = assertApiError(await app.client().get('/api/auth/me', { bearer: expired }), 401, 'UNAUTHENTICATED');
        assert.match(error.message, /expired/i);
      });

      it('rejects a tampered token carried in the cookie as well', async () => {
        const client = await app.loginAs('customer');
        const good = client.cookie('appt_access')!.value;
        client.setCookie('appt_access', `${good.slice(0, -4)}AAAA`);
        assertApiError(await client.get('/api/auth/me'), 401, 'UNAUTHENTICATED');
      });
    });

    it('answers 404 when a still-valid token belongs to a deleted account', async () => {
      const client = await freshCustomer();
      await app.db.query('DELETE FROM users WHERE id = $1', [client.user!.id]);
      assertApiError(await client.get('/api/auth/me'), 404, 'NOT_FOUND');
    });
  });

  describe('refresh', () => {
    it('rotates the refresh token and returns a fresh session', async () => {
      const client = await freshCustomer();
      const original = refreshCookieOf(client);

      const res = await client.post<AuthResponse>('/api/auth/refresh');
      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, client.user!.id);
      assert.ok(res.body.accessToken);
      assert.equal(res.body.expiresInSeconds, 900);
      assert.notEqual(refreshCookieOf(client), original, 'a refresh token is single-use');

      // The new session works.
      assert.equal((await client.get('/api/auth/me')).status, 200);
    });

    it('records the rotation chain: the old token points at its replacement', async () => {
      const client = await freshCustomer();
      await client.post('/api/auth/refresh');

      const { rows } = await app.db.query<{ revoked: boolean; replaced: boolean }>(
        `SELECT revoked_at IS NOT NULL AS revoked, replaced_by IS NOT NULL AS replaced
         FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at`,
        [client.user!.id],
      );
      assert.deepEqual(rows, [
        { revoked: true, replaced: true },
        { revoked: false, replaced: false },
      ]);
    });

    it('rejects the old refresh token once it has been rotated', async () => {
      const client = await freshCustomer();
      const original = refreshCookieOf(client);
      assert.equal((await client.post('/api/auth/refresh')).status, 200);
      await ageRotations(client.user!.id);

      const replay = app.client();
      replay.setCookie('appt_refresh', original, '/api/auth');
      assertApiError(await replay.post('/api/auth/refresh'), 401, 'UNAUTHENTICATED');
    });

    it('treats replay of a rotated token as theft: every session of that user is revoked', async () => {
      const victim = await freshCustomer();
      const stolen = refreshCookieOf(victim);
      assert.equal((await victim.post('/api/auth/refresh')).status, 200);
      await ageRotations(victim.user!.id);

      // A second device, signed in separately, is collateral damage by design.
      const otherDevice = app.client();
      await otherDevice.login(victim.user!.email, STRONG_PASSWORD);

      const attacker = app.client();
      attacker.setCookie('appt_refresh', stolen, '/api/auth');
      const error = assertApiError(await attacker.post('/api/auth/refresh'), 401, 'UNAUTHENTICATED');
      assert.match(error.message, /security/i);

      assert.equal(await liveTokens(victim.user!.id), 0);
      assertApiError(await victim.post('/api/auth/refresh'), 401, 'UNAUTHENTICATED');
      assertApiError(await otherDevice.post('/api/auth/refresh'), 401, 'UNAUTHENTICATED');

      // The account is not locked: signing in again works.
      assert.equal((await app.client().login(victim.user!.email, STRONG_PASSWORD)).status, 200);
    });

    it('clears the cookies when a refresh fails, so the browser stops retrying a dead token', async () => {
      const client = await freshCustomer();
      const original = refreshCookieOf(client);
      await client.post('/api/auth/refresh');
      await ageRotations(client.user!.id);

      const stale = app.client();
      stale.setCookie('appt_refresh', original, '/api/auth');
      const res = await stale.post('/api/auth/refresh');
      assert.equal(res.status, 401);
      assert.equal(stale.cookie('appt_refresh'), undefined);
      assert.ok(res.setCookies.some((c) => c.startsWith('appt_refresh=;')));
    });

    it('lets only one of several simultaneous refreshes with the same token succeed', async () => {
      const client = await freshCustomer();
      const token = refreshCookieOf(client);
      const attempt = () => {
        const tab = app.client();
        tab.setCookie('appt_refresh', token, '/api/auth');
        return tab.post('/api/auth/refresh');
      };

      const results = await Promise.all([attempt(), attempt(), attempt()]);

      assert.equal(results.filter((r) => r.status === 200).length, 1, 'a single-use token must be redeemable once');
      for (const loser of results.filter((r) => r.status !== 200)) assertApiError(loser, 401, 'SESSION_SUPERSEDED');
    });

    describe('two tabs racing to refresh (the grace window)', () => {
      it('answers the losing tab SESSION_SUPERSEDED and keeps every session alive', async () => {
        const browser = await freshCustomer();
        const otherDevice = app.client();
        await otherDevice.login(browser.user!.email, STRONG_PASSWORD);
        const tab = browser.fork();

        assert.equal((await browser.post('/api/auth/refresh')).status, 200);
        const error = assertApiError(await tab.post('/api/auth/refresh'), 401, 'SESSION_SUPERSEDED');
        assert.match(error.message, /another tab/);

        assert.equal(await liveTokens(browser.user!.id), 2, 'the winner’s successor and the other device');
        assert.equal((await browser.post('/api/auth/refresh')).status, 200, 'the winning tab carries on');
        assert.equal((await otherDevice.post('/api/auth/refresh')).status, 200, 'other devices are untouched');
      });

      it('does not clear the cookies, which in a real browser now hold the winner’s successor', async () => {
        const browser = await freshCustomer();
        const tab = browser.fork();
        await browser.post('/api/auth/refresh');

        const res = await tab.post('/api/auth/refresh');
        assert.equal(res.status, 401);
        assert.deepEqual(res.setCookies, []);
      });

      it('treats the same token as replay once the window has passed', async () => {
        const browser = await freshCustomer();
        const tab = browser.fork();
        await browser.post('/api/auth/refresh');
        await ageRotations(browser.user!.id);

        const error = assertApiError(await tab.post('/api/auth/refresh'), 401, 'UNAUTHENTICATED');
        assert.match(error.message, /security/i);
        assert.equal(await liveTokens(browser.user!.id), 0);
      });

      it('gives no grace to a token ended by logout: presenting it again is still replay', async () => {
        const browser = await freshCustomer();
        const token = refreshCookieOf(browser);
        const otherDevice = app.client();
        await otherDevice.login(browser.user!.email, STRONG_PASSWORD);
        assert.equal((await browser.post('/api/auth/logout')).status, 204);

        const replay = app.client();
        replay.setCookie('appt_refresh', token, '/api/auth');
        assertApiError(await replay.post('/api/auth/refresh'), 401, 'UNAUTHENTICATED');
        assert.equal(await liveTokens(browser.user!.id), 0);
      });
    });

    it('requires a refresh cookie', async () => {
      assertApiError(await app.client().post('/api/auth/refresh'), 401, 'UNAUTHENTICATED');
    });

    it('rejects a refresh token the server never issued', async () => {
      const client = app.client();
      client.setCookie('appt_refresh', 'A'.repeat(43), '/api/auth');
      assertApiError(await client.post('/api/auth/refresh'), 401, 'UNAUTHENTICATED');
    });

    it('rejects an expired refresh token', async () => {
      const client = await freshCustomer();
      await app.db.query(
        `UPDATE refresh_tokens
         SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
         WHERE user_id = $1`,
        [client.user!.id],
      );
      const error = assertApiError(await client.post('/api/auth/refresh'), 401, 'UNAUTHENTICATED');
      assert.match(error.message, /expired/i);
    });

    it('does not accept an access token in place of a refresh token', async () => {
      const client = app.client();
      const login = await client.login(SEED.users.customer.email, SEED.password);
      const confused = app.client();
      confused.setCookie('appt_refresh', login.body.accessToken, '/api/auth');
      assertApiError(await confused.post('/api/auth/refresh'), 401, 'UNAUTHENTICATED');
    });
  });

  describe('logout', () => {
    it('ends the session: cookies are cleared and the refresh token stops working', async () => {
      const client = await freshCustomer();
      const refreshToken = refreshCookieOf(client);

      const res = await client.post('/api/auth/logout');
      assert.equal(res.status, 204);
      assert.equal(client.cookie('appt_access'), undefined);
      assert.equal(client.cookie('appt_refresh'), undefined);
      assert.ok(res.setCookies.some((c) => c.startsWith('appt_access=;') && /HttpOnly/i.test(c)));
      assert.ok(res.setCookies.some((c) => c.startsWith('appt_refresh=;') && c.includes('Path=/api/auth')));

      const stale = app.client();
      stale.setCookie('appt_refresh', refreshToken, '/api/auth');
      assertApiError(await stale.post('/api/auth/refresh'), 401, 'UNAUTHENTICATED');
      assertApiError(await client.get('/api/auth/me'), 401, 'UNAUTHENTICATED');
    });

    it('is idempotent: signing out twice, or when never signed in, is not an error', async () => {
      const client = await freshCustomer();
      const refreshToken = refreshCookieOf(client);
      assert.equal((await client.post('/api/auth/logout')).status, 204);
      assert.equal((await client.post('/api/auth/logout')).status, 204);
      assert.equal((await app.client().post('/api/auth/logout')).status, 204);

      const garbage = app.client();
      garbage.setCookie('appt_refresh', 'not-a-real-token', '/api/auth');
      assert.equal((await garbage.post('/api/auth/logout')).status, 204);

      const replayed = app.client();
      replayed.setCookie('appt_refresh', refreshToken, '/api/auth');
      assert.equal((await replayed.post('/api/auth/logout')).status, 204);
    });

    it('only ends this device by default, and every device with ?everywhere=true', async () => {
      const email = uniqueEmail('devices');
      const signUp = await app.client().post('/api/auth/signup', {
        email,
        password: STRONG_PASSWORD,
        fullName: 'Many Devices',
        businessSlug: SEED.bluewave.slug,
      });
      assert.equal(signUp.status, 201);

      const laptop = app.client();
      const phone = app.client();
      await laptop.login(email, STRONG_PASSWORD);
      await phone.login(email, STRONG_PASSWORD);

      assert.equal((await laptop.post('/api/auth/logout')).status, 204);
      assert.equal((await phone.post('/api/auth/refresh')).status, 200, 'the other device keeps its session');

      assert.equal((await phone.post('/api/auth/logout?everywhere=true')).status, 204);
      const { rows } = await app.db.query<{ live: number }>(
        `SELECT count(*)::int AS live FROM refresh_tokens t JOIN users u ON u.id = t.user_id
         WHERE u.email = $1 AND t.revoked_at IS NULL`,
        [email],
      );
      assert.equal(rows[0]!.live, 0);
    });
  });
});
