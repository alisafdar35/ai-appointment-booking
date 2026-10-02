import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { AppointmentDto, AuthResponse, AvailabilityDto, ServiceDto } from '@appt/shared';
import { assertApiError } from '../helpers/assertions.js';
import { book, instant } from '../helpers/booking.js';
import { SEED, addDays, freshDate, futureDate, nextDstTransition, nextWeekday } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient } from '../helpers/apiClient.js';
import { todayInZone } from '../../src/lib/time.js';

/**
 * What a booking must survive beyond the happy path: retries and double
 * clicks, a slot that goes while the form is open, a database that fails
 * mid-confirmation, closed days, and wall-clock times that DST skips or
 * repeats.
 */

type Booked = { appointment: AppointmentDto };
type Availability = { availability: AvailabilityDto };

const IDEMPOTENCY = 'Idempotency-Key';

describe('booking integrity', () => {
  let app: TestApp;
  let customer: ApiClient;
  let neighbour: ApiClient;

  async function joinBluewave(name: string): Promise<ApiClient> {
    const client = app.client();
    const res = await client.post<AuthResponse>('/api/auth/signup', {
      email: `${name}-${randomUUID().slice(0, 8)}@integrity.test`,
      password: 'Sup3rSecretPass',
      fullName: name,
      businessSlug: SEED.bluewave.slug,
    });
    assert.equal(res.status, 201);
    client.adopt(res.body);
    return client;
  }

  /**
   * A tenant of its own with the booking policy a test needs. The owner books
   * for themselves; its 30-minute "Initial Consultation" is the service.
   */
  async function tenant(policy: { timezone: string; opensAt: string; closesAt: string; openDays?: number[] }) {
    const owner = app.client();
    const res = await owner.post<AuthResponse>('/api/auth/signup', {
      email: `owner-${randomUUID().slice(0, 8)}@integrity.test`,
      password: 'Sup3rSecretPass',
      fullName: 'Edge Owner',
      businessName: 'Edge Clinic',
    });
    assert.equal(res.status, 201);
    owner.adopt(res.body);
    await app.db.query(
      'UPDATE businesses SET timezone = $2, opens_at = $3, closes_at = $4, open_days = $5 WHERE id = $1',
      [res.body.user.businessId, policy.timezone, policy.opensAt, policy.closesAt, policy.openDays ?? [1, 2, 3, 4, 5, 6, 7]],
    );
    const { services } = (await owner.get<{ services: ServiceDto[] }>('/api/services')).body;
    const serviceId = services.find((s) => s.name === 'Initial Consultation')!.id;
    return { owner, businessId: res.body.user.businessId, serviceId, timezone: policy.timezone };
  }

  const slots = async (client: ApiClient, serviceId: string, date: string) => {
    const res = await client.get<Availability>(`/api/services/${serviceId}/availability?date=${date}`);
    assert.equal(res.status, 200);
    return res.body.availability;
  };

  const countAt = async (date: string, time: string, serviceId: string = SEED.services.routineCheckup.id) => {
    const { rows } = await app.db.query(
      `SELECT count(*)::int AS n FROM appointments
       WHERE service_id = $1 AND starts_at = $2 AND status IN ('pending', 'confirmed')`,
      [serviceId, instant(date, time)],
    );
    return rows[0].n as number;
  };

  before(async () => {
    app = await startTestApp();
    [customer, neighbour] = await Promise.all([joinBluewave('customer'), joinBluewave('neighbour')]);
  });
  after(async () => {
    await app.stop();
  });

  describe('Idempotency-Key on POST /api/appointments', () => {
    const withKey = (key: string) => ({ headers: { [IDEMPOTENCY]: key } });

    it('replays the original 201 for a retry with the same key and details, and books only once', async () => {
      const date = freshDate();
      const key = randomUUID();
      const body = { serviceId: SEED.services.routineCheckup.id, date, time: '10:00', notes: 'first visit' };

      const first = await customer.post<Booked>('/api/appointments', body, withKey(key));
      assert.equal(first.status, 201);
      assert.equal(first.headers.get('idempotent-replayed'), null);

      // The response was "lost"; the client resends exactly the same request.
      const retry = await customer.post<Booked>('/api/appointments', body, withKey(key));
      assert.equal(retry.status, 201);
      assert.equal(retry.headers.get('idempotent-replayed'), 'true');
      assert.deepEqual(retry.body, first.body);
      assert.equal(await countAt(date, '10:00'), 1);
    });

    it('lets exactly one booking through when the same key arrives several times at once (a double-clicked Confirm)', async () => {
      const date = freshDate();
      const key = randomUUID();
      const body = { serviceId: SEED.services.routineCheckup.id, date, time: '11:00' };

      const results = await Promise.all(
        Array.from({ length: 5 }, () => customer.post<Booked>('/api/appointments', body, withKey(key))),
      );

      assert.deepEqual(results.map((r) => r.status), [201, 201, 201, 201, 201]);
      assert.equal(new Set(results.map((r) => r.body.appointment.id)).size, 1, 'every caller sees the one booking');
      assert.equal(results.filter((r) => r.headers.get('idempotent-replayed') === null).length, 1);
      assert.equal(await countAt(date, '11:00'), 1);
    });

    it('matches on the validated request, so a retry serialised differently still replays', async () => {
      const date = freshDate();
      const key = randomUUID();
      const first = await customer.post<Booked>(
        '/api/appointments',
        { serviceId: SEED.services.routineCheckup.id, date, time: '12:00' },
        withKey(key),
      );
      // Same booking: explicit default source, a blank note, different key order.
      const retry = await customer.post<Booked>(
        '/api/appointments',
        { notes: '   ', source: 'form', time: '12:00', date, serviceId: SEED.services.routineCheckup.id },
        withKey(key),
      );
      assert.equal(retry.status, 201);
      assert.equal(retry.body.appointment.id, first.body.appointment.id);
    });

    it('refuses the same key with different booking details, and books nothing for it', async () => {
      const date = freshDate();
      const key = randomUUID();
      const body = { serviceId: SEED.services.routineCheckup.id, date, time: '13:00' };
      assert.equal((await customer.post('/api/appointments', body, withKey(key))).status, 201);

      const changed = await customer.post('/api/appointments', { ...body, time: '14:00' }, withKey(key));
      const error = assertApiError(changed, 422, 'IDEMPOTENCY_KEY_REUSED');
      assert.match(error.message, /different booking/);
      assert.equal(await countAt(date, '14:00'), 0);
    });

    it('keeps keys per user: another customer using the same key gets a booking of their own', async () => {
      const date = freshDate();
      const key = 'shared-key-123';
      const mine = await customer.post<Booked>(
        '/api/appointments',
        { serviceId: SEED.services.routineCheckup.id, date, time: '09:00' },
        withKey(key),
      );
      const theirs = await neighbour.post<Booked>(
        '/api/appointments',
        { serviceId: SEED.services.routineCheckup.id, date, time: '09:30' },
        withKey(key),
      );
      assert.equal(theirs.status, 201);
      assert.equal(theirs.headers.get('idempotent-replayed'), null);
      assert.notEqual(theirs.body.appointment.id, mine.body.appointment.id);
      assert.equal(theirs.body.appointment.customer.id, neighbour.user!.id);
    });

    it('does not spend a key on a refused booking, so the same key works once the problem is fixed', async () => {
      const date = freshDate();
      const key = randomUUID();
      const body = { serviceId: SEED.services.routineCheckup.id, date, time: '15:00' };
      const taken = (await book(neighbour, { date, time: '15:00' })).body.appointment;

      assertApiError(await customer.post('/api/appointments', body, withKey(key)), 409, 'SLOT_UNAVAILABLE');
      assert.equal((await neighbour.post(`/api/appointments/${taken.id}/cancel`, {})).status, 200);

      const retry = await customer.post<Booked>('/api/appointments', body, withKey(key));
      assert.equal(retry.status, 201);
      assert.equal(retry.headers.get('idempotent-replayed'), null);
    });

    it('replays the response as it was sent, even after the booking has since been cancelled', async () => {
      const key = randomUUID();
      const body = { serviceId: SEED.services.routineCheckup.id, date: freshDate(), time: '10:30' };
      const first = await customer.post<Booked>('/api/appointments', body, withKey(key));
      await customer.post(`/api/appointments/${first.body.appointment.id}/cancel`, {});

      const retry = await customer.post<Booked>('/api/appointments', body, withKey(key));
      assert.equal(retry.status, 201);
      assert.equal(retry.body.appointment.status, 'confirmed');
      assert.equal(retry.body.appointment.id, first.body.appointment.id);
    });

    it('forgets a key after 24 hours, so it can describe a new booking', async () => {
      const key = randomUUID();
      const date = freshDate();
      await customer.post('/api/appointments', { serviceId: SEED.services.routineCheckup.id, date, time: '09:00' }, withKey(key));
      await app.db.query(`UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = $1`, [key]);

      const reused = await customer.post<Booked>(
        '/api/appointments',
        { serviceId: SEED.services.routineCheckup.id, date, time: '16:00' },
        withKey(key),
      );
      assert.equal(reused.status, 201);
      assert.equal(reused.headers.get('idempotent-replayed'), null);
    });

    it('rejects a malformed key as a field error before booking anything', async () => {
      const date = freshDate();
      for (const key of ['two words', 'x'.repeat(256)]) {
        const res = await customer.post(
          '/api/appointments',
          { serviceId: SEED.services.routineCheckup.id, date, time: '10:00' },
          withKey(key),
        );
        const error = assertApiError(res, 400, 'VALIDATION_FAILED');
        assert.ok(error.details?.[IDEMPOTENCY], JSON.stringify(error.details));
      }
      assert.equal(await countAt(date, '10:00'), 0);
    });

    it('is optional: without a key, a repeated request is refused rather than booked twice', async () => {
      const date = freshDate();
      const body = { serviceId: SEED.services.routineCheckup.id, date, time: '10:00' };
      const [a, b] = await Promise.all([
        customer.post('/api/appointments', body),
        customer.post('/api/appointments', body),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [201, 409]);
      assert.equal(await countAt(date, '10:00'), 1);
    });
  });

  describe('a slot that goes while the form is open', () => {
    it('is rechecked at confirmation and refused with 409, and the picker then shows it taken', async () => {
      const date = freshDate();
      const before = await slots(customer, SEED.services.routineCheckup.id, date);
      assert.equal(before.slots.find((s) => s.time === '11:30')?.available, true);

      assert.equal((await book(neighbour, { date, time: '11:30' })).status, 201);

      assertApiError(await book(customer, { date, time: '11:30' }), 409, 'SLOT_UNAVAILABLE');
      const after = await slots(customer, SEED.services.routineCheckup.id, date);
      assert.equal(after.slots.find((s) => s.time === '11:30')?.available, false);
    });
  });

  describe('when the database fails during confirmation', () => {
    async function withFailure(kind: 'insert' | 'commit', run: () => Promise<void>) {
      // A trigger stands in for the database failing: on the insert itself, or
      // (deferred) at COMMIT, after every statement has already succeeded.
      await app.db.query(`
        CREATE OR REPLACE FUNCTION fail_booking_fn() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated database failure'; END $$;`);
      await app.db.query(
        kind === 'insert'
          ? `CREATE TRIGGER fail_booking BEFORE INSERT ON appointments
             FOR EACH ROW WHEN (NEW.notes = 'simulate failure') EXECUTE FUNCTION fail_booking_fn()`
          : `CREATE CONSTRAINT TRIGGER fail_booking AFTER INSERT ON appointments DEFERRABLE INITIALLY DEFERRED
             FOR EACH ROW WHEN (NEW.notes = 'simulate failure') EXECUTE FUNCTION fail_booking_fn()`,
      );
      try {
        await run();
      } finally {
        await app.db.query('DROP TRIGGER IF EXISTS fail_booking ON appointments');
        await app.db.query('DROP FUNCTION IF EXISTS fail_booking_fn()');
      }
    }

    for (const kind of ['insert', 'commit'] as const) {
      it(`answers 500 and stores nothing when the ${kind} fails, never a false confirmation`, async () => {
        const date = freshDate();
        const key = randomUUID();
        const body = { serviceId: SEED.services.routineCheckup.id, date, time: '10:00', notes: 'simulate failure' };

        await withFailure(kind, async () => {
          const res = await customer.post('/api/appointments', body, { headers: { [IDEMPOTENCY]: key } });
          const error = assertApiError(res, 500, 'INTERNAL');
          assert.doesNotMatch(error.message, /simulated/, 'the database error is not leaked');
          assert.equal(await countAt(date, '10:00'), 0);
          const { rows } = await app.db.query('SELECT 1 FROM idempotency_keys WHERE key = $1', [key]);
          assert.equal(rows.length, 0, 'the key is not spent on a booking that never committed');
        });

        // Once the database recovers, the client's retry with the same key books for real.
        const retry = await customer.post<Booked>('/api/appointments', body, { headers: { [IDEMPOTENCY]: key } });
        assert.equal(retry.status, 201);
        assert.equal(retry.headers.get('idempotent-replayed'), null);
        assert.equal(await countAt(date, '10:00'), 1);
      });
    }
  });

  describe('closed days', () => {
    let t: Awaited<ReturnType<typeof tenant>>;
    let saturday: string;
    let monday: string;

    before(async () => {
      t = await tenant({ timezone: 'America/New_York', opensAt: '09:00', closesAt: '17:00', openDays: [1, 2, 3, 4, 5] });
      saturday = nextWeekday(futureDate(10), 6);
      monday = nextWeekday(futureDate(10), 1);
    });

    it('offers no times on a closed weekday, and says the day is closed', async () => {
      const closed = await slots(t.owner, t.serviceId, saturday);
      assert.equal(closed.closed, true);
      assert.deepEqual(closed.slots, []);

      const open = await slots(t.owner, t.serviceId, monday);
      assert.equal(open.closed, false);
      assert.equal(open.slots[0]?.time, '09:00');
    });

    it('refuses a booking on a closed weekday with the opening days in the message', async () => {
      const res = await t.owner.post('/api/appointments', { serviceId: t.serviceId, date: saturday, time: '10:00' });
      const error = assertApiError(res, 422, 'OUTSIDE_BUSINESS_HOURS');
      assert.equal(error.message, "We're closed on Saturdays. We take bookings Monday to Friday.");
      assert.equal((await t.owner.post('/api/appointments', { serviceId: t.serviceId, date: monday, time: '10:00' })).status, 201);
    });

    it('suggests only open days to the chat, through the same booking service', async () => {
      const service = await import('../../src/modules/appointments/service.js');
      const result = await service.attemptBooking(
        { businessId: t.businessId, userId: t.owner.user!.id },
        { serviceId: t.serviceId, date: saturday, time: '11:00', source: 'chat' },
      );
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.code, 'closed_day');
      const suggested = (!result.ok && result.suggestions) || [];
      assert.ok(suggested.length > 0);
      for (const s of suggested) {
        const isoDay = ((new Date(`${s.date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
        assert.ok(isoDay <= 5, `${s.date} is a weekend day`);
      }
    });

    it('is judged on the business’s calendar date, not UTC’s', async () => {
      // 20:00 on a Friday in New York is already Saturday in UTC: still open.
      const friday = nextWeekday(futureDate(10), 5);
      await app.db.query(`UPDATE businesses SET closes_at = '23:30' WHERE id = $1`, [t.businessId]);
      try {
        const res = await t.owner.post<Booked>('/api/appointments', { serviceId: t.serviceId, date: friday, time: '20:00' });
        assert.equal(res.status, 201);
        assert.equal(res.body.appointment.startsAt.slice(0, 10), addDays(friday, 1));
      } finally {
        await app.db.query(`UPDATE businesses SET closes_at = '17:00' WHERE id = $1`, [t.businessId]);
      }
    });

    it('is a validated column: weekdays are 1 (Monday) to 7 (Sunday) and at least one is open', async () => {
      for (const days of ['{}', '{0}', '{8}', '{1,2,3,4,5,6,7,1}']) {
        await assert.rejects(
          app.db.query('UPDATE businesses SET open_days = $2 WHERE id = $1', [t.businessId, days]),
          /businesses_open_days_valid/,
        );
      }
    });
  });

  describe('wall-clock times that DST skips or repeats (America/New_York, open around the clock)', () => {
    let t: Awaited<ReturnType<typeof tenant>>;
    const spring = nextDstTransition('America/New_York', 'spring');
    const fall = nextDstTransition('America/New_York', 'fall');

    before(async () => {
      t = await tenant({ timezone: 'America/New_York', opensAt: '00:00', closesAt: '23:30' });
    });

    it('refuses a time inside the spring-forward gap (02:30 does not exist) instead of booking 03:30', async () => {
      const res = await t.owner.post('/api/appointments', { serviceId: t.serviceId, date: spring, time: '02:30' });
      const error = assertApiError(res, 400, 'VALIDATION_FAILED');
      assert.match(error.message, /does not exist/);
      assert.ok(error.details?.time);
      const { rows } = await app.db.query('SELECT count(*)::int AS n FROM appointments WHERE business_id = $1', [t.businessId]);
      assert.equal(rows[0].n, 0);
    });

    it('leaves the skipped times out of the picker, so it never offers one', async () => {
      const day = await slots(t.owner, t.serviceId, spring);
      const times = day.slots.map((s) => s.time);
      assert.ok(!times.includes('02:00') && !times.includes('02:30'));
      assert.ok(times.includes('01:30') && times.includes('03:00'));
      // 00:00 to 23:00 every half hour, less the two that do not exist.
      assert.equal(times.length, 47 - 2);
    });

    it('books a repeated fall-back time (01:30 happens twice) as its second, standard-time occurrence', async () => {
      const res = await t.owner.post<Booked>('/api/appointments', { serviceId: t.serviceId, date: fall, time: '01:30' });
      assert.equal(res.status, 201);
      // 01:30 EST is 06:30Z; the first occurrence, 01:30 EDT, would be 05:30Z.
      assert.equal(res.body.appointment.startsAt, `${fall}T06:30:00.000Z`);
      assert.equal(res.body.appointment.endsAt, `${fall}T07:00:00.000Z`);

      const day = await slots(t.owner, t.serviceId, fall);
      assert.equal(day.slots.filter((s) => s.time === '01:30').length, 1, 'the picker lists it once');
      assert.equal(day.slots.find((s) => s.time === '01:30')?.available, false, 'and agrees it is now taken');
    });
  });

  describe('near midnight, far from UTC', () => {
    it('anchors the day to the business’s calendar: 00:00 and 23:00 in Kiritimati (UTC+14) fall on different UTC days', async () => {
      const t = await tenant({ timezone: 'Pacific/Kiritimati', opensAt: '00:00', closesAt: '23:30' });
      const date = futureDate(12, t.timezone);

      const early = await t.owner.post<Booked>('/api/appointments', { serviceId: t.serviceId, date, time: '00:00' });
      const late = await t.owner.post<Booked>('/api/appointments', { serviceId: t.serviceId, date, time: '23:00' });
      assert.equal(early.body.appointment.startsAt, `${addDays(date, -1)}T10:00:00.000Z`);
      assert.equal(late.body.appointment.startsAt, `${date}T09:00:00.000Z`);

      // "Today" is the business's today: its midnight has passed even when UTC's date is still yesterday.
      const today = todayInZone(t.timezone);
      const res = await t.owner.post('/api/appointments', { serviceId: t.serviceId, date: today, time: '00:00' });
      assertApiError(res, 422, 'APPOINTMENT_IN_PAST');
    });
  });
});
