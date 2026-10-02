import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AppointmentDto, AssistantTurnDto, ChatSessionDto } from '@appt/shared';
import { assertApiError } from '../helpers/assertions.js';
import { book } from '../helpers/booking.js';
import { SEED, freshDate } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient } from '../helpers/apiClient.js';

/**
 * Cross-cutting authorisation checks: every protected endpoint at once, so one
 * that trusts an identity in its body, or answers without a session, fails
 * here even if its own test file forgot to look. The list of protected
 * endpoints is checked against the routes Express actually registers, so a new
 * route must be added to the 401 sweep (or to PUBLIC_ROUTES) or this file fails.
 */

/** The only routes reachable without a session. */
const PUBLIC_ROUTES = [
  'GET /api/health',
  'POST /api/auth/signup',
  'POST /api/auth/login',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
];

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  regexp: RegExp;
  handle: { stack?: Layer[] };
}

/** Every "METHOD /path" the Express app registers under /api, with params as ":name". */
function registeredApiRoutes(app: { _router: { stack: Layer[] } }): string[] {
  // Express 4 keeps a router's mount path only as a regexp: /^\/api\/chat\/?(?=\/|$)/i.
  const mountOf = (layer: Layer) =>
    layer.regexp.source.replace(/^\^/, '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
  const routes: string[] = [];
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const path of paths) {
          for (const method of Object.keys(layer.route.methods)) routes.push(`${method.toUpperCase()} ${prefix}${path}`);
        }
      } else if (layer.handle.stack) {
        walk(layer.handle.stack, prefix + mountOf(layer));
      }
    }
  };
  walk(app._router.stack, '');
  return routes.filter((r) => / \/api\//.test(r)).map((r) => r.replace(/\/$/, ''));
}

describe('authorisation across the API', () => {
  let app: TestApp;
  let customer: ApiClient;
  let staff: ApiClient;
  let northside: ApiClient;
  let appointment: AppointmentDto;
  let session: ChatSessionDto;

  before(async () => {
    app = await startTestApp();
    [customer, staff, northside] = await Promise.all([
      app.loginAs('customer'),
      app.loginAs('staff'),
      app.loginAs('northsideOwner'),
    ]);
    appointment = (await book(customer, { date: freshDate(), time: '10:00' })).body.appointment;
    session = (await customer.post<{ session: ChatSessionDto }>('/api/chat/sessions')).body.session;
  });
  after(async () => {
    await app.stop();
  });

  const protectedEndpoints = (): [string, string, unknown?][] => [
    ['GET', '/api/auth/me'],
    ['GET', '/api/services'],
    ['GET', `/api/services/${SEED.services.routineCheckup.id}/availability?date=${freshDate()}`],
    ['GET', '/api/appointments'],
    ['GET', `/api/appointments/${appointment.id}`],
    ['POST', '/api/appointments', { serviceId: SEED.services.routineCheckup.id, date: freshDate(), time: '10:00' }],
    ['POST', `/api/appointments/${appointment.id}/cancel`, {}],
    ['GET', '/api/chat/sessions'],
    ['POST', '/api/chat/sessions'],
    ['GET', `/api/chat/sessions/${session.id}`],
    ['POST', '/api/chat/messages', { content: 'hello', sessionId: session.id }],
    ['POST', '/api/chat/draft', { sessionId: session.id, slots: {} }],
    ['GET', '/api/ai/summary'],
  ];

  describe('without a session', () => {
    it('sweeps every registered /api route except the public ones', async () => {
      const { createApp } = await import('../../src/app.js');
      const registered = registeredApiRoutes(createApp() as never);
      for (const route of PUBLIC_ROUTES) assert.ok(registered.includes(route), `${route} is no longer registered`);

      const swept = protectedEndpoints();
      const unswept = registered
        .filter((route) => !PUBLIC_ROUTES.includes(route))
        .filter((route) => {
          const [method, pattern] = route.split(' ') as [string, string];
          const matcher = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`);
          return !swept.some(([m, path]) => m === method && matcher.test(path.split('?')[0]!));
        });
      assert.deepEqual(unswept, [], 'add these to protectedEndpoints() or PUBLIC_ROUTES');
      assert.equal(registered.length, PUBLIC_ROUTES.length + swept.length, 'one sweep entry per protected route');
    });

    it('answers 401 on every protected endpoint, with nothing but the error envelope', async () => {
      const anon = app.client();
      for (const [method, path, body] of protectedEndpoints()) {
        const res = await anon.request(method, path, body === undefined ? {} : { json: body });
        assertApiError(res, 401, 'UNAUTHENTICATED');
        assert.deepEqual(Object.keys(res.body as object), ['error'], `${method} ${path} must not carry data`);
        assert.deepEqual(res.setCookies, [], `${method} ${path} must not start a session`);
      }
    });

    it('answers 401 to a malformed, truncated or tampered token on every protected endpoint', async () => {
      const good = customer.accessToken!;
      const [header, payload] = good.split('.');
      const tokens = [
        'not-a-jwt',
        `${header}.${payload}`,
        `${good.slice(0, -6)}AAAAAA`,
        `${header}.${Buffer.from('{"sub":"x"}').toString('base64url')}.${good.split('.')[2]}`,
      ];
      for (const bearer of tokens) {
        for (const [method, path, body] of protectedEndpoints()) {
          const res = await app.client().request(method, path, { bearer, ...(body === undefined ? {} : { json: body }) });
          assertApiError(res, 401, 'UNAUTHENTICATED');
        }
      }
      // Nothing above changed the appointment the endpoints point at.
      const still = await customer.get<{ appointment: AppointmentDto }>(`/api/appointments/${appointment.id}`);
      assert.equal(still.body.appointment.status, 'confirmed');
    });
  });

  describe('identity claimed in a request body', () => {
    const impostor = () => ({
      userId: SEED.users.staff.id,
      customerId: SEED.users.staff.id,
      businessId: SEED.northside.id,
      role: 'owner',
      status: 'cancelled',
    });

    it('books for the signed-in caller in their own tenant, as confirmed, whatever the body says', async () => {
      const res = await customer.post<{ appointment: AppointmentDto }>('/api/appointments', {
        serviceId: SEED.services.routineCheckup.id,
        date: freshDate(),
        time: '11:00',
        ...impostor(),
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.appointment.customer.id, SEED.users.customer.id);
      assert.equal(res.body.appointment.status, 'confirmed');
      const { rows } = await app.db.query('SELECT business_id, user_id FROM appointments WHERE id = $1', [
        res.body.appointment.id,
      ]);
      assert.deepEqual(rows[0], { business_id: SEED.bluewave.id, user_id: SEED.users.customer.id });
    });

    it('opens conversations for the caller only', async () => {
      const created = await customer.post<{ session: ChatSessionDto }>('/api/chat/sessions', impostor());
      const sent = await customer.post<AssistantTurnDto>('/api/chat/messages', { content: 'hi there', ...impostor() });
      assert.equal(created.status, 201);
      assert.equal(sent.status, 201);
      const { rows } = await app.db.query(
        'SELECT DISTINCT business_id, user_id FROM chat_sessions WHERE id = ANY($1::uuid[])',
        [[created.body.session.id, sent.body.sessionId]],
      );
      assert.deepEqual(rows, [{ business_id: SEED.bluewave.id, user_id: SEED.users.customer.id }]);
      // Neither conversation is visible to the user the body named.
      assertApiError(await staff.get(`/api/chat/sessions/${created.body.session.id}`), 404, 'NOT_FOUND');
    });

    it('cancels only within the caller’s own reach, whatever the body says', async () => {
      const res = await northside.post(`/api/appointments/${appointment.id}/cancel`, {
        businessId: SEED.bluewave.id,
        userId: SEED.users.customer.id,
      });
      assertApiError(res, 404, 'NOT_FOUND');
      const still = await customer.get<{ appointment: AppointmentDto }>(`/api/appointments/${appointment.id}`);
      assert.equal(still.body.appointment.status, 'confirmed');
    });
  });
});
