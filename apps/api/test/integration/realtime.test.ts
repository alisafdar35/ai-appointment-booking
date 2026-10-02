import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import {
  SOCKET_EVENTS,
  type AppointmentDto,
  type AssistantTurnDto,
  type AssistantTypingPayload,
  type AuthResponse,
} from '@appt/shared';
import { eventually, sleep } from '../helpers/assertions.js';
import { book } from '../helpers/booking.js';
import { SEED, freshDate } from '../helpers/fixtures.js';
import { closeAllSockets, connect, connectExpectingRefusal } from '../helpers/socketClient.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient } from '../helpers/apiClient.js';

/**
 * Real-time delivery is an enhancement over a REST API that is complete on its
 * own, so what matters is that it is correct when present: authenticated at the
 * handshake, delivered only to the people an event concerns (the customer, and
 * their business's staff), and no longer-lived than the credential that opened it.
 */
describe('realtime', () => {
  let app: TestApp;
  let customer: ApiClient;
  let staff: ApiClient;
  let northside: ApiClient;
  /** A second customer of the same business, who must not hear about the first one's bookings. */
  let neighbour: ApiClient;

  /** A customer of Bluewave of its own, for tests that end every session of a user. */
  async function signUpCustomer(label: string): Promise<ApiClient> {
    const client = app.client();
    const res = await client.post<AuthResponse>('/api/auth/signup', {
      email: `${label}-${Date.now()}@bluewave.test`,
      password: 'Sup3rSecretPass',
      fullName: 'Realtime Tester',
      businessSlug: SEED.bluewave.slug,
    });
    assert.equal(res.status, 201);
    client.adopt(res.body);
    return client;
  }

  before(async () => {
    app = await startTestApp({ realtime: true });
    [customer, staff, northside] = await Promise.all([
      app.loginAs('customer'),
      app.loginAs('staff'),
      app.loginAs('northsideOwner'),
    ]);
    neighbour = await signUpCustomer('neighbour');
  });
  afterEach(() => closeAllSockets());
  after(async () => {
    closeAllSockets();
    await app.stop();
  });

  /** Long enough for a stray event to have arrived if one was going to. */
  const settle = () => sleep(250);

  describe('handshake', () => {
    it('accepts a valid access token', async () => {
      const connection = await connect(app.baseUrl, { token: customer.accessToken });
      assert.equal(connection.socket.connected, true);
    });

    it('accepts the token as a Bearer header too, and over long-polling when websockets are unavailable', async () => {
      const viaHeader = await connect(app.baseUrl, { token: customer.accessToken, asHeader: true, transports: ['polling'] });
      assert.equal(viaHeader.socket.connected, true);
    });

    it('refuses a connection with no token', async () => {
      assert.equal(await connectExpectingRefusal(app.baseUrl), 'UNAUTHENTICATED');
    });

    const bad: [string, () => string][] = [
      ['a garbage token', () => 'definitely-not-a-jwt'],
      [
        'a token signed with the wrong secret',
        () => jwt.sign({ sub: SEED.users.customer.id, bid: SEED.bluewave.id, role: 'customer' }, 'x'.repeat(40), { issuer: 'appt-api' }),
      ],
      [
        'an expired token',
        () =>
          jwt.sign(
            { sub: SEED.users.customer.id, bid: SEED.bluewave.id, role: 'customer', exp: Math.floor(Date.now() / 1000) - 60 },
            process.env.JWT_SECRET!,
            { issuer: 'appt-api' },
          ),
      ],
      ['a refresh token', () => customer.cookie('appt_refresh')!.value],
    ];
    for (const [label, token] of bad) {
      it(`refuses ${label}`, async () => {
        assert.equal(await connectExpectingRefusal(app.baseUrl, { token: token() }), 'UNAUTHENTICATED');
      });
    }
  });

  describe('appointment events', () => {
    it('delivers appointment:created to the user who booked, with the same appointment the API returned', async () => {
      const connection = await connect(app.baseUrl, { token: customer.accessToken });

      const res = await book(customer, { date: freshDate(), time: '10:00' });
      assert.equal(res.status, 201);

      const event = await connection.waitFor<{ appointment: AppointmentDto }>(SOCKET_EVENTS.APPOINTMENT_CREATED);
      assert.deepEqual(event.appointment, res.body.appointment);
    });

    it('delivers appointment:updated when an appointment is cancelled', async () => {
      const { appointment } = (await book(customer, { date: freshDate(), time: '10:30' })).body;
      const connection = await connect(app.baseUrl, { token: customer.accessToken });

      await customer.post(`/api/appointments/${appointment.id}/cancel`, { reason: 'Changed plans' });

      const event = await connection.waitFor<{ appointment: AppointmentDto }>(SOCKET_EVENTS.APPOINTMENT_UPDATED);
      assert.equal(event.appointment.id, appointment.id);
      assert.equal(event.appointment.status, 'cancelled');
      assert.equal(event.appointment.cancellationReason, 'Changed plans');
    });

    it('tells the customer when staff cancel their appointment, as well as the staff member', async () => {
      const { appointment } = (await book(customer, { date: freshDate(), time: '11:00' })).body;
      const customerSocket = await connect(app.baseUrl, { token: customer.accessToken });
      const staffSocket = await connect(app.baseUrl, { token: staff.accessToken });

      await staff.post(`/api/appointments/${appointment.id}/cancel`, { reason: 'Clinic closed' });

      for (const connection of [customerSocket, staffSocket]) {
        const event = await connection.waitFor<{ appointment: AppointmentDto }>(SOCKET_EVENTS.APPOINTMENT_UPDATED);
        assert.equal(event.appointment.id, appointment.id);
        assert.equal(event.appointment.status, 'cancelled');
      }
    });

    it('reaches every open tab of the same user', async () => {
      const tabs = await Promise.all([
        connect(app.baseUrl, { token: customer.accessToken }),
        connect(app.baseUrl, { token: customer.accessToken }),
      ]);
      await book(customer, { date: freshDate(), time: '12:00' });
      for (const tab of tabs) await tab.waitFor(SOCKET_EVENTS.APPOINTMENT_CREATED);
    });

    it('tells the business’s staff about a customer’s booking, and no other customer or tenant', async () => {
      const [mine, colleague, otherCustomer, outsider] = await Promise.all([
        connect(app.baseUrl, { token: customer.accessToken }),
        connect(app.baseUrl, { token: staff.accessToken }),
        connect(app.baseUrl, { token: neighbour.accessToken }),
        connect(app.baseUrl, { token: northside.accessToken }),
      ]);

      const res = await book(customer, { date: freshDate(), time: '14:00' });
      await mine.waitFor(SOCKET_EVENTS.APPOINTMENT_CREATED);
      const seenByStaff = await colleague.waitFor<{ appointment: AppointmentDto }>(SOCKET_EVENTS.APPOINTMENT_CREATED);
      assert.deepEqual(seenByStaff.appointment, res.body.appointment, 'the staff dashboard gets the booking as it happens');
      await settle();

      assert.deepEqual(otherCustomer.events, [], 'another customer of the same business heard nothing');
      assert.deepEqual(outsider.events, [], 'another tenant heard nothing');
      assert.equal(colleague.received(SOCKET_EVENTS.APPOINTMENT_CREATED).length, 1, 'delivered once, not once per room');
    });

    it('delivers a staff member’s own booking to them once, though they are in both rooms', async () => {
      const colleague = await connect(app.baseUrl, { token: staff.accessToken });
      const theirs = await book(staff, { date: freshDate(), time: '14:00' });
      const event = await colleague.waitFor<{ appointment: AppointmentDto }>(SOCKET_EVENTS.APPOINTMENT_CREATED);
      assert.equal(event.appointment.id, theirs.body.appointment.id);
      await settle();
      assert.equal(colleague.received(SOCKET_EVENTS.APPOINTMENT_CREATED).length, 1);
    });

    it('does not deliver anything when the booking is refused', async () => {
      const connection = await connect(app.baseUrl, { token: customer.accessToken });
      const res = await book(customer, { date: freshDate(), time: '03:00' });
      assert.equal(res.status, 422);
      await settle();
      assert.deepEqual(connection.events, []);
    });
  });

  describe('chat events', () => {
    it('mirrors each assistant turn to the user’s other tabs', async () => {
      const connection = await connect(app.baseUrl, { token: customer.accessToken });
      const res = await customer.post<AssistantTurnDto>('/api/chat/messages', { content: 'I need a routine checkup' });
      assert.equal(res.status, 201);

      const turn = await connection.waitFor<AssistantTurnDto>(SOCKET_EVENTS.ASSISTANT_TURN);
      assert.deepEqual(turn, res.body);
    });

    it('announces an appointment made through chat the same way as one made through the form', async () => {
      const connection = await connect(app.baseUrl, { token: customer.accessToken });
      const say = (content: string, sessionId?: string) =>
        customer.post<AssistantTurnDto>('/api/chat/messages', { content, ...(sessionId ? { sessionId } : {}) });

      const first = await say(`routine checkup on ${freshDate()} at 10am`);
      const second = await say('yes', first.body.sessionId);
      assert.equal(second.body.action, 'booked');

      const event = await connection.waitFor<{ appointment: AppointmentDto }>(SOCKET_EVENTS.APPOINTMENT_CREATED);
      assert.equal(event.appointment.id, second.body.appointment!.id);
      assert.equal(event.appointment.source, 'chat');
      assert.equal(connection.received(SOCKET_EVENTS.ASSISTANT_TURN).length, 2);
    });

    it('shows the other tabs that the assistant is typing, and clears it before the turn arrives', async () => {
      const connection = await connect(app.baseUrl, { token: customer.accessToken });
      const res = await customer.post<AssistantTurnDto>('/api/chat/messages', { content: 'I need a routine checkup' });
      await connection.waitFor(SOCKET_EVENTS.ASSISTANT_TURN);

      const { sessionId } = res.body;
      assert.deepEqual(
        connection.events.map((e) => [e.name, e.payload as unknown]).filter(([name]) => name !== SOCKET_EVENTS.ASSISTANT_TURN),
        [
          [SOCKET_EVENTS.ASSISTANT_TYPING, { sessionId, typing: true } satisfies AssistantTypingPayload],
          [SOCKET_EVENTS.ASSISTANT_TYPING, { sessionId, typing: false } satisfies AssistantTypingPayload],
        ],
      );
      assert.deepEqual(
        connection.events.map((e) => e.name),
        [SOCKET_EVENTS.ASSISTANT_TYPING, SOCKET_EVENTS.ASSISTANT_TYPING, SOCKET_EVENTS.ASSISTANT_TURN],
      );
    });

    it('clears the typing indicator when the turn fails', async () => {
      const first = await customer.post<AssistantTurnDto>('/api/chat/messages', { content: 'checkup please' });
      const { sessionId } = first.body;
      const connection = await connect(app.baseUrl, { token: customer.accessToken });

      // Refuse the assistant's reply at the database, so the request fails
      // after the user's message was stored and typing began.
      await app.db.query(`ALTER TABLE chat_messages ADD CONSTRAINT test_no_replies CHECK (role <> 'assistant') NOT VALID`);
      try {
        const res = await customer.post('/api/chat/messages', { content: 'tomorrow', sessionId });
        assert.equal(res.status, 500);
      } finally {
        await app.db.query('ALTER TABLE chat_messages DROP CONSTRAINT test_no_replies');
      }

      await settle();
      assert.deepEqual(connection.received(SOCKET_EVENTS.ASSISTANT_TYPING), [
        { sessionId, typing: true },
        { sessionId, typing: false },
      ]);
      assert.deepEqual(connection.received(SOCKET_EVENTS.ASSISTANT_TURN), []);
    });

    it('shows no typing indicator for a message that is refused before the assistant is asked', async () => {
      const connection = await connect(app.baseUrl, { token: customer.accessToken });
      const res = await customer.post('/api/chat/messages', { content: 'hello', sessionId: '00000000-0000-4000-8000-000000000000' });
      assert.equal(res.status, 404);
      await settle();
      assert.deepEqual(connection.events, []);
    });

    it('keeps one user’s conversation out of another user’s socket', async () => {
      const other = await connect(app.baseUrl, { token: staff.accessToken });
      await customer.post('/api/chat/messages', { content: 'something private about my teeth' });
      await settle();
      assert.deepEqual(other.events, []);
    });
  });

  describe('socket lifetime', () => {
    const disconnected = (connection: Awaited<ReturnType<typeof connect>>) =>
      eventually(() => !connection.socket.connected, { timeoutMs: 4000 });

    it('closes a socket when the access token that opened it expires', async () => {
      const shortLived = jwt.sign(
        { sub: SEED.users.customer.id, bid: SEED.bluewave.id, role: 'customer', email: SEED.users.customer.email },
        process.env.JWT_SECRET!,
        { issuer: 'appt-api', algorithm: 'HS256', expiresIn: 1 },
      );
      const connection = await connect(app.baseUrl, { token: shortLived });
      assert.equal(connection.socket.connected, true);
      await disconnected(connection);
    });

    it('closes every socket of a user who signs out everywhere', async () => {
      const user = await signUpCustomer('everywhere');
      const tabs = await Promise.all([
        connect(app.baseUrl, { token: user.accessToken }),
        connect(app.baseUrl, { token: user.accessToken }),
      ]);
      const bystander = await connect(app.baseUrl, { token: customer.accessToken });

      assert.equal((await user.post('/api/auth/logout?everywhere=true')).status, 204);
      for (const tab of tabs) await disconnected(tab);
      assert.equal(bystander.socket.connected, true, 'other users are untouched');
    });

    it('closes every socket of a user whose refresh token was replayed', async () => {
      const user = await signUpCustomer('replayed');
      const connection = await connect(app.baseUrl, { token: user.accessToken });
      const stolen = user.fork();

      assert.equal((await user.post('/api/auth/refresh')).status, 200);
      // Presented again after the grace window would be theft; the server cannot
      // tell who is who, so every session ends — and with it the live socket.
      await app.db.query(
        `UPDATE refresh_tokens SET revoked_at = revoked_at - interval '1 minute' WHERE user_id = $1 AND revoked_at IS NOT NULL`,
        [user.user!.id],
      );
      assert.equal((await stolen.post('/api/auth/refresh')).status, 401);
      await disconnected(connection);
    });
  });
});
