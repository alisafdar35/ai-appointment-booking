import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AppointmentDto, AuthResponse } from '@appt/shared';
import { assertApiError, eventually, isUtcIso, isUuid } from '../helpers/assertions.js';
import { book, instant } from '../helpers/booking.js';
import { SEED, freshDate, futureDate, pastDate } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient } from '../helpers/apiClient.js';
import { todayInZone, zonedParts } from '../../src/lib/time.js';

type Appointments = { appointments: AppointmentDto[] };

function assertAppointmentShape(a: AppointmentDto): void {
  assert.ok(isUuid(a.id));
  assert.ok(['pending', 'confirmed', 'cancelled', 'completed', 'no_show'].includes(a.status));
  assert.ok(['chat', 'form', 'admin'].includes(a.source));
  assert.ok(isUtcIso(a.startsAt), `startsAt must be UTC ISO-8601, got ${a.startsAt}`);
  assert.ok(isUtcIso(a.endsAt));
  assert.ok(isUtcIso(a.createdAt));
  assert.ok(Date.parse(a.endsAt) > Date.parse(a.startsAt));
  assert.ok(a.notes === null || typeof a.notes === 'string');
  assert.ok(a.cancellationReason === null || typeof a.cancellationReason === 'string');
  assert.ok(a.chatSessionId === null || isUuid(a.chatSessionId));
  assert.ok(isUuid(a.service.id));
  assert.equal(typeof a.service.name, 'string');
  assert.ok(Number.isInteger(a.service.durationMinutes));
  assert.ok(Number.isInteger(a.service.priceCents));
  assert.ok(isUuid(a.customer.id));
  assert.equal(typeof a.customer.fullName, 'string');
  assert.equal(typeof a.customer.email, 'string');
}

describe('appointments', () => {
  let app: TestApp;
  let customer: ApiClient;
  let staff: ApiClient;
  let owner: ApiClient;
  let northside: ApiClient;
  /** A second customer of the same business, for "someone else's booking" cases. */
  let neighbour: ApiClient;

  before(async () => {
    app = await startTestApp();
    [customer, staff, owner, northside] = await Promise.all([
      app.loginAs('customer'),
      app.loginAs('staff'),
      app.loginAs('owner'),
      app.loginAs('northsideOwner'),
    ]);
    neighbour = app.client();
    const signup = await neighbour.post<AuthResponse>('/api/auth/signup', {
      email: 'neighbour@bluewave.test',
      password: 'Sup3rSecretPass',
      fullName: 'Nina Neighbour',
      businessSlug: SEED.bluewave.slug,
    });
    neighbour.adopt(signup.body);
  });
  after(async () => {
    await app.stop();
  });

  describe('creating', () => {
    it('books through the form and returns the full appointment', async () => {
      const date = freshDate();
      const res = await book(customer, { date, time: '10:00', notes: '  First visit  ' });

      assert.equal(res.status, 201);
      const a = res.body.appointment;
      assertAppointmentShape(a);
      assert.equal(a.status, 'confirmed');
      assert.equal(a.source, 'form');
      assert.equal(a.notes, 'First visit');
      assert.equal(a.cancellationReason, null);
      assert.equal(a.chatSessionId, null);
      assert.equal(a.service.id, SEED.services.routineCheckup.id);
      assert.equal(a.service.name, 'Routine Checkup');
      assert.equal(a.service.durationMinutes, 30);
      assert.equal(a.service.priceCents, 8000);
      assert.equal(a.customer.id, SEED.users.customer.id);
      assert.equal(a.customer.email, SEED.users.customer.email);
      assert.equal(a.customer.fullName, 'Marcus Reed');
    });

    it('interprets the time in the business timezone and derives the end from the service duration', async () => {
      const date = freshDate();
      const { body } = await book(customer, { date, time: '14:00', serviceId: SEED.services.teethWhitening.id });

      assert.equal(body.appointment.startsAt, instant(date, '14:00', SEED.bluewave.timezone));
      assert.equal(body.appointment.endsAt, instant(date, '15:00', SEED.bluewave.timezone));
      // 14:00 in New York is never 14:00Z: the offset is applied, whatever the season.
      assert.notEqual(body.appointment.startsAt.slice(11, 16), '14:00');
    });

    it('persists the booking against the caller and their tenant', async () => {
      const date = freshDate();
      const { body } = await book(customer, { date, time: '11:00' });
      const { rows } = await app.db.query(
        'SELECT business_id, user_id, status, source FROM appointments WHERE id = $1',
        [body.appointment.id],
      );
      assert.deepEqual(rows[0], {
        business_id: SEED.bluewave.id,
        user_id: SEED.users.customer.id,
        status: 'confirmed',
        source: 'form',
      });
    });

    it('stores a blank note as no note', async () => {
      const res = await book(customer, { date: freshDate(), time: '10:30', notes: '    ' });
      assert.equal(res.status, 201);
      assert.equal(res.body.appointment.notes, null);
    });

    it('requires authentication', async () => {
      assertApiError(await book(app.client(), { date: freshDate(), time: '10:00' }), 401, 'UNAUTHENTICATED');
    });

    it('takes tenant and user from the token, ignoring any the body claims', async () => {
      const date = freshDate();
      const res = await book(customer, {
        date,
        time: '12:00',
        ...({ businessId: SEED.northside.id, userId: SEED.users.owner.id } as object),
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.appointment.customer.id, SEED.users.customer.id);
      const { rows } = await app.db.query('SELECT business_id FROM appointments WHERE id = $1', [
        res.body.appointment.id,
      ]);
      assert.equal(rows[0].business_id, SEED.bluewave.id);
    });

    it('lets staff book on their own behalf', async () => {
      const res = await book(staff, { date: freshDate(), time: '09:30' });
      assert.equal(res.status, 201);
      assert.equal(res.body.appointment.customer.id, SEED.users.staff.id);
    });

    describe('provenance', () => {
      // No flow books on someone else's behalf yet, so 'admin' would only let
      // the caller record themselves as the customer of an "admin" booking.
      it('does not accept "admin" as a source from any client, staff included', async () => {
        for (const client of [customer, staff, owner]) {
          const error = assertApiError(await book(client, { date: freshDate(), time: '13:00', source: 'admin' }), 400, 'VALIDATION_FAILED');
          assert.ok(error.details?.source, 'the source field is named');
        }
        const { rows } = await app.db.query(`SELECT 1 FROM appointments WHERE source = 'admin'`);
        assert.equal(rows.length, 0);
      });

      it('links a booking to the caller’s own conversation', async () => {
        const session = await customer.post<{ session: { id: string } }>('/api/chat/sessions');
        const res = await book(customer, {
          date: freshDate(),
          time: '15:00',
          chatSessionId: session.body.session.id,
          source: 'chat',
        });
        assert.equal(res.status, 201);
        assert.equal(res.body.appointment.chatSessionId, session.body.session.id);
        assert.equal(res.body.appointment.source, 'chat');
      });

      it('refuses a conversation that does not exist, instead of failing with a 500', async () => {
        const res = await book(customer, {
          date: freshDate(),
          time: '15:30',
          chatSessionId: '11111111-2222-4333-8444-555555555555',
        });
        assertApiError(res, 404, 'NOT_FOUND');
      });

      it('refuses another user’s conversation, in the same tenant or another', async () => {
        const mine = await customer.post<{ session: { id: string } }>('/api/chat/sessions');
        const theirs = await northside.post<{ session: { id: string } }>('/api/chat/sessions');

        const asNeighbour = await book(neighbour, { date: freshDate(), time: '09:00', chatSessionId: mine.body.session.id });
        assertApiError(asNeighbour, 404, 'NOT_FOUND');

        const crossTenant = await book(customer, { date: freshDate(), time: '09:30', chatSessionId: theirs.body.session.id });
        assertApiError(crossTenant, 404, 'NOT_FOUND');

        const { rows } = await app.db.query('SELECT count(*)::int AS n FROM appointments WHERE chat_session_id = ANY($1)', [
          [mine.body.session.id, theirs.body.session.id],
        ]);
        assert.equal(rows[0].n, 0);
      });
    });

    describe('validation', () => {
      const valid = () => ({
        serviceId: SEED.services.routineCheckup.id,
        date: futureDate(60),
        time: '10:00',
      });

      const invalid: [string, Record<string, unknown>, string][] = [
        ['a missing service', { serviceId: undefined }, 'serviceId'],
        ['a service id that is not a uuid', { serviceId: 'routine-checkup' }, 'serviceId'],
        ['a missing date', { date: undefined }, 'date'],
        ['a date in the wrong format', { date: '10/12/2031' }, 'date'],
        ['a month that does not exist', { date: '2031-13-01' }, 'date'],
        ['a missing time', { time: undefined }, 'time'],
        ['a 12-hour time', { time: '9am' }, 'time'],
        ['an out-of-range time', { time: '24:30' }, 'time'],
        ['notes over 2000 characters', { notes: 'x'.repeat(2001) }, 'notes'],
        ['an unknown source', { source: 'telepathy' }, 'source'],
        ['a non-uuid chat session', { chatSessionId: 'abc' }, 'chatSessionId'],
      ];

      for (const [label, patch, field] of invalid) {
        it(`rejects ${label} with the field named in the details`, async () => {
          const res = await customer.post('/api/appointments', { ...valid(), ...patch });
          const error = assertApiError(res, 400, 'VALIDATION_FAILED');
          assert.ok(error.details?.[field]?.length, `expected details for "${field}", got ${JSON.stringify(error.details)}`);
        });
      }

      it('reports every problem in one response', async () => {
        const res = await customer.post('/api/appointments', {});
        const error = assertApiError(res, 400, 'VALIDATION_FAILED');
        assert.deepEqual(Object.keys(error.details ?? {}).sort(), ['date', 'serviceId', 'time']);
      });

      it('rejects a day that does not exist, or a year the database cannot represent, with a 400 rather than a server error', async () => {
        for (const date of ['2031-02-31', '0000-01-01']) {
          const res = await customer.post('/api/appointments', { ...valid(), date });
          assertApiError(res, 400, 'VALIDATION_FAILED');
        }
      });

      it('accepts notes of exactly 2000 characters', async () => {
        const res = await book(customer, { date: freshDate(), time: '16:00', notes: 'n'.repeat(2000) });
        assert.equal(res.status, 201);
      });

      it('answers 404 for a service that does not exist', async () => {
        const res = await book(customer, { date: freshDate(), time: '10:00', serviceId: '99999999-9999-4999-8999-999999999999' });
        assertApiError(res, 404, 'NOT_FOUND');
      });

      it('answers 404 for another tenant’s service, never confirming it exists', async () => {
        const res = await book(customer, {
          date: freshDate(),
          time: '10:00',
          serviceId: SEED.services.generalPractice.id,
        });
        assertApiError(res, 404, 'NOT_FOUND');
      });

      it('answers 404 for a service that has been retired', async () => {
        const { rows } = await app.db.query<{ id: string }>(
          `INSERT INTO services (business_id, name, duration_minutes, is_active)
           VALUES ($1, 'Retired Treatment', 30, false) RETURNING id`,
          [SEED.bluewave.id],
        );
        assertApiError(
          await book(customer, { date: freshDate(), time: '10:00', serviceId: rows[0]!.id }),
          404,
          'NOT_FOUND',
        );
      });
    });
  });

  describe('business rules', () => {
    it('refuses a time that is in the past', async () => {
      assertApiError(await book(customer, { date: pastDate(1), time: '10:00' }), 422, 'APPOINTMENT_IN_PAST');
      assertApiError(await book(customer, { date: pastDate(30), time: '09:00' }), 422, 'APPOINTMENT_IN_PAST');
    });

    it('refuses a time earlier today in the business’s timezone', async (t) => {
      // The latest half-hour slot strictly before the current minute, today in New York.
      const now = new Date();
      const { hour, minute } = zonedParts(now, SEED.bluewave.timezone);
      const minutes = hour * 60 + minute;
      if (minutes < 1) return t.skip('it is exactly midnight in New York: nothing earlier today');
      const earlier = Math.floor((minutes - 1) / 30) * 30;
      const time = `${String(Math.floor(earlier / 60)).padStart(2, '0')}:${String(earlier % 60).padStart(2, '0')}`;

      const res = await book(customer, { date: todayInZone(SEED.bluewave.timezone, now), time });
      assertApiError(res, 422, 'APPOINTMENT_IN_PAST');
    });

    it('checks "in the past" before opening hours', async () => {
      assertApiError(await book(customer, { date: pastDate(1), time: '03:00' }), 422, 'APPOINTMENT_IN_PAST');
    });

    const outsideHours: [string, string, string?][] = [
      ['before opening', '08:30'],
      ['one minute before opening', '08:59'],
      ['at closing time', '17:00'],
      ['after closing', '19:00'],
      ['at midnight', '00:00'],
      ['late at night', '23:30'],
      ['when the service would run past closing', '16:45'],
      ['when a long service would run past closing', '16:30', SEED.services.teethWhitening.id],
    ];

    for (const [label, time, serviceId] of outsideHours) {
      it(`refuses a booking ${label} (${time})`, async () => {
        const res = await book(customer, {
          date: freshDate(),
          time,
          ...(serviceId ? { serviceId } : {}),
        });
        const error = assertApiError(res, 422, 'OUTSIDE_BUSINESS_HOURS');
        assert.match(error.message, /9:00 AM to 5:00 PM/);
      });
    }

    it('allows a booking that ends exactly at closing time, and one that starts exactly at opening', async () => {
      const date = freshDate();
      assert.equal((await book(customer, { date, time: '09:00' })).status, 201);
      // 16:30 + 30 minutes = 17:00 on the dot.
      assert.equal((await book(customer, { date, time: '16:30' })).status, 201);
      // A 60-minute service may start at 16:00 for the same reason. (Another
      // customer: this one is already busy from 16:30.)
      assert.equal(
        (await book(neighbour, { date, time: '16:00', serviceId: SEED.services.teethWhitening.id })).status,
        201,
      );
    });

    it('accepts only start times on the half-hour grid the availability picker offers', async () => {
      const date = freshDate();
      const error = assertApiError(await book(customer, { date, time: '09:07' }), 400, 'VALIDATION_FAILED');
      assert.match(error.message, /hour or half hour/);
      assert.ok(error.details?.time, 'the time field is named, so a form can point at it');
      // Nothing was written, so 09:00 and 09:30 are both still free.
      assert.equal((await book(customer, { date, time: '09:00' })).status, 201);
      assert.equal((await book(customer, { date, time: '09:30' })).status, 201);
    });

    it('measures opening hours in the business timezone, not UTC', async () => {
      // 09:00 New York is 13:00/14:00Z. If hours were compared in UTC this would be refused.
      assert.equal((await book(customer, { date: freshDate(), time: '09:00' })).status, 201);
      // Northside (London, 08:00-18:00) is a different clock entirely.
      const res = await book(northside, {
        date: freshDate(SEED.northside.timezone),
        time: '08:00',
        serviceId: SEED.services.generalPractice.id,
      });
      assert.equal(res.status, 201);
    });
  });

  describe('a customer in two places at once', () => {
    it('refuses a second booking that overlaps one the customer already holds, for any service', async () => {
      const date = freshDate();
      assert.equal((await book(customer, { date, time: '15:00', serviceId: SEED.services.teethWhitening.id })).status, 201);

      // Routine Checkup is free at 15:30, but this customer is in the whitening chair until 16:00.
      const error = assertApiError(await book(customer, { date, time: '15:30' }), 409, 'CUSTOMER_BUSY');
      assert.match(error.message, /already have an appointment/);

      // Another customer can take that checkup, and this one can book once the whitening ends.
      assert.equal((await book(neighbour, { date, time: '15:30' })).status, 201);
      assert.equal((await book(customer, { date, time: '16:00' })).status, 201);
    });

    it('frees the time again once the customer cancels the first booking', async () => {
      const date = freshDate();
      const first = (await book(customer, { date, time: '11:00' })).body.appointment;
      assertApiError(await book(customer, { date, time: '11:00', serviceId: SEED.services.orthodonticReview.id }), 409, 'CUSTOMER_BUSY');
      await customer.post(`/api/appointments/${first.id}/cancel`, {});
      assert.equal((await book(customer, { date, time: '11:00', serviceId: SEED.services.orthodonticReview.id })).status, 201);
    });
  });

  describe('double booking', () => {
    const whitening = SEED.services.teethWhitening.id;

    it('refuses a slot that is already taken', async () => {
      const date = freshDate();
      assert.equal((await book(customer, { date, time: '10:00' })).status, 201);

      const error = assertApiError(await book(neighbour, { date, time: '10:00' }), 409, 'SLOT_UNAVAILABLE');
      assert.match(error.message, /already booked/i);
    });

    it('refuses any overlap, not only an identical start time', async () => {
      const date = freshDate();
      // Occupies 14:00-15:00.
      assert.equal((await book(customer, { date, time: '14:00', serviceId: whitening })).status, 201);

      for (const time of ['13:30', '14:00', '14:30']) {
        assertApiError(
          await book(neighbour, { date, time, serviceId: whitening }),
          409,
          'SLOT_UNAVAILABLE',
        );
      }
    });

    it('allows back-to-back bookings: an end time is not part of the slot', async () => {
      const date = freshDate();
      assert.equal((await book(customer, { date, time: '14:00', serviceId: whitening })).status, 201);
      // Ends exactly when the first one starts, and starts exactly when it ends.
      assert.equal((await book(neighbour, { date, time: '13:00', serviceId: whitening })).status, 201);
      assert.equal((await book(neighbour, { date, time: '15:00', serviceId: whitening })).status, 201);
    });

    it('does not let different services block each other, since each is its own bookable resource', async () => {
      const date = freshDate();
      assert.equal((await book(customer, { date, time: '11:00' })).status, 201);
      const other = await book(neighbour, { date, time: '11:00', serviceId: SEED.services.orthodonticReview.id });
      assert.equal(other.status, 201);
    });

    it('does not let another tenant’s bookings block this one', async () => {
      const date = freshDate();
      assert.equal((await book(customer, { date, time: '10:00' })).status, 201);
      const res = await book(northside, {
        date: freshDate(SEED.northside.timezone),
        time: '10:00',
        serviceId: SEED.services.generalPractice.id,
      });
      assert.equal(res.status, 201);
    });
  });

  describe('listing', () => {
    let customerCreated: AppointmentDto;
    let neighbourCreated: AppointmentDto;

    before(async () => {
      customerCreated = (await book(customer, { date: freshDate(), time: '10:00' })).body.appointment;
      neighbourCreated = (await book(neighbour, { date: freshDate(), time: '10:30' })).body.appointment;
    });

    it('shows a customer only their own appointments', async () => {
      const res = await customer.get<Appointments>('/api/appointments?limit=100');
      assert.equal(res.status, 200);
      assert.ok(res.body.appointments.length > 0);
      for (const a of res.body.appointments) {
        assertAppointmentShape(a);
        assert.equal(a.customer.id, SEED.users.customer.id);
      }
      const ids = res.body.appointments.map((a) => a.id);
      assert.ok(ids.includes(customerCreated.id));
      assert.ok(!ids.includes(neighbourCreated.id));
      // ...including the seeded history.
      assert.ok(ids.includes('ffffffff-0000-0000-0000-000000000001'));
      assert.ok(ids.includes('ffffffff-0000-0000-0000-000000000003'));
    });

    it('shows a customer nothing that belongs to staff, even when it is in their tenant', async () => {
      const ids = (await customer.get<Appointments>('/api/appointments?limit=100')).body.appointments.map((a) => a.id);
      assert.ok(!ids.includes('ffffffff-0000-0000-0000-000000000004'), 'the seeded staff booking must not leak');
    });

    it('shows staff and owners the whole tenant', async () => {
      for (const viewer of [staff, owner]) {
        const res = await viewer.get<Appointments>('/api/appointments?limit=100');
        const ids = res.body.appointments.map((a) => a.id);
        assert.ok(ids.includes(customerCreated.id));
        assert.ok(ids.includes(neighbourCreated.id));
        assert.ok(ids.includes('ffffffff-0000-0000-0000-000000000004'));
        const customers = new Set(res.body.appointments.map((a) => a.customer.id));
        assert.ok(customers.size > 1, 'a tenant-wide view spans several customers');
      }
    });

    it('never mixes tenants: another business’s staff see only their own appointments', async () => {
      const ownBooking = await book(northside, {
        date: freshDate(SEED.northside.timezone),
        time: '09:00',
        serviceId: SEED.services.generalPractice.id,
      });
      const { appointments } = (await northside.get<Appointments>('/api/appointments?limit=100')).body;
      const ids = appointments.map((a) => a.id);
      assert.ok(ids.includes(ownBooking.body.appointment.id));

      const { rows } = await app.db.query<{ business_id: string }>(
        'SELECT DISTINCT business_id FROM appointments WHERE id = ANY($1)',
        [ids],
      );
      assert.deepEqual(rows, [{ business_id: SEED.northside.id }]);
      assert.ok(!ids.includes(customerCreated.id));
    });

    it('orders newest start first', async () => {
      const { appointments } = (await staff.get<Appointments>('/api/appointments?limit=100')).body;
      const starts = appointments.map((a) => Date.parse(a.startsAt));
      assert.deepEqual(starts, [...starts].sort((x, y) => y - x));
    });

    it('reads upcoming appointments soonest first, so a limit drops the far future and never tomorrow', async () => {
      const soon = (await book(customer, { date: futureDate(11), time: '09:00' })).body.appointment;
      const later = (await book(customer, { date: futureDate(12), time: '09:00' })).body.appointment;
      const latest = (await book(customer, { date: futureDate(13), time: '09:00' })).body.appointment;

      const upcoming = (await customer.get<Appointments>('/api/appointments?window=upcoming&limit=100')).body.appointments;
      const ids = upcoming.map((a) => a.id);
      assert.ok(ids.indexOf(soon.id) < ids.indexOf(later.id), 'soon before later');
      assert.ok(ids.indexOf(later.id) < ids.indexOf(latest.id), 'later before latest');
      const starts = upcoming.map((a) => Date.parse(a.startsAt));
      assert.deepEqual(starts, [...starts].sort((x, y) => x - y));

      // A limit takes the soonest appointments, not the furthest.
      const limited = (await customer.get<Appointments>('/api/appointments?window=upcoming&limit=2')).body.appointments;
      assert.deepEqual(limited.map((a) => a.id), ids.slice(0, 2));
    });

    it('reads past appointments most recent first', async () => {
      const past = (await customer.get<Appointments>('/api/appointments?window=past&limit=100')).body.appointments;
      const starts = past.map((a) => Date.parse(a.startsAt));
      assert.deepEqual(starts, [...starts].sort((x, y) => y - x));
    });

    it('filters by status', async () => {
      const cancelled = (await staff.get<Appointments>('/api/appointments?status=cancelled')).body.appointments;
      assert.ok(cancelled.length >= 1);
      assert.ok(cancelled.every((a) => a.status === 'cancelled'));

      const completed = (await customer.get<Appointments>('/api/appointments?status=completed')).body.appointments;
      assert.deepEqual(
        completed.map((a) => a.id),
        ['ffffffff-0000-0000-0000-000000000003'],
      );
    });

    it('filters by several statuses at once, so a view can leave cancelled bookings out', async () => {
      const live = (await staff.get<Appointments>('/api/appointments?status=pending,confirmed&limit=100')).body.appointments;
      assert.ok(live.some((a) => a.status === 'pending'));
      assert.ok(live.some((a) => a.status === 'confirmed'));
      assert.ok(live.every((a) => a.status === 'pending' || a.status === 'confirmed'));

      const all = (await staff.get<Appointments>('/api/appointments?limit=100')).body.appointments;
      assert.equal(live.length, all.filter((a) => a.status === 'pending' || a.status === 'confirmed').length);
    });

    it('keeps upcoming soonest first when filtering by status', async () => {
      const upcoming = (
        await customer.get<Appointments>('/api/appointments?window=upcoming&status=pending,confirmed&limit=100')
      ).body.appointments;
      assert.ok(upcoming.length >= 2);
      const starts = upcoming.map((a) => Date.parse(a.startsAt));
      assert.deepEqual(starts, [...starts].sort((x, y) => x - y));
      assert.ok(upcoming.every((a) => a.status !== 'cancelled'));
    });

    it('splits upcoming from past around the current time', async () => {
      const now = Date.now();
      const upcoming = (await customer.get<Appointments>('/api/appointments?window=upcoming&limit=100')).body.appointments;
      const past = (await customer.get<Appointments>('/api/appointments?window=past&limit=100')).body.appointments;
      assert.ok(upcoming.length > 0 && past.length > 0);
      assert.ok(upcoming.every((a) => Date.parse(a.startsAt) >= now - 1000));
      assert.ok(past.every((a) => Date.parse(a.startsAt) < now + 1000));
      const all = (await customer.get<Appointments>('/api/appointments?window=all&limit=100')).body.appointments;
      assert.equal(all.length, upcoming.length + past.length);
    });

    it('honours limit, and bounds it', async () => {
      assert.equal((await staff.get<Appointments>('/api/appointments?limit=2')).body.appointments.length, 2);
      assert.ok((await staff.get<Appointments>('/api/appointments')).body.appointments.length <= 50, 'default limit is 50');
      for (const bad of ['0', '101', '-1', 'ten', '1.5']) {
        assertApiError(await staff.get(`/api/appointments?limit=${bad}`), 400, 'VALIDATION_FAILED');
      }
    });

    it('rejects an unknown status or window', async () => {
      assertApiError(await staff.get('/api/appointments?status=archived'), 400, 'VALIDATION_FAILED');
      assertApiError(await staff.get('/api/appointments?status=pending,archived'), 400, 'VALIDATION_FAILED');
      assertApiError(await staff.get('/api/appointments?window=tomorrow'), 400, 'VALIDATION_FAILED');
    });

    it('requires authentication', async () => {
      assertApiError(await app.client().get('/api/appointments'), 401, 'UNAUTHENTICATED');
    });
  });

  describe('reading one', () => {
    let booked: AppointmentDto;

    before(async () => {
      booked = (await book(customer, { date: freshDate(), time: '12:00' })).body.appointment;
    });

    it('returns it to its owner, and to staff and owners of the tenant', async () => {
      for (const viewer of [customer, staff, owner]) {
        const res = await viewer.get<{ appointment: AppointmentDto }>(`/api/appointments/${booked.id}`);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.appointment, booked);
      }
    });

    it('answers 404, not 403, to another customer of the same tenant', async () => {
      assertApiError(await neighbour.get(`/api/appointments/${booked.id}`), 404, 'NOT_FOUND');
    });

    it('answers 404, not 403, to a user from another tenant', async () => {
      assertApiError(await northside.get(`/api/appointments/${booked.id}`), 404, 'NOT_FOUND');
    });

    it('answers 404 for an id that does not exist and 400 for one that is not a uuid', async () => {
      assertApiError(await customer.get('/api/appointments/99999999-9999-4999-8999-999999999999'), 404, 'NOT_FOUND');
      assertApiError(await customer.get('/api/appointments/not-a-uuid'), 400, 'VALIDATION_FAILED');
    });

    it('requires authentication', async () => {
      assertApiError(await app.client().get(`/api/appointments/${booked.id}`), 401, 'UNAUTHENTICATED');
    });
  });

  describe('cancelling', () => {
    const cancel = (client: ApiClient, id: string, body?: unknown) =>
      client.post<{ appointment: AppointmentDto }>(`/api/appointments/${id}/cancel`, body ?? {});

    it('cancels the caller’s own appointment and records the reason', async () => {
      const { appointment } = (await book(customer, { date: freshDate(), time: '10:00' })).body;

      const res = await cancel(customer, appointment.id, { reason: '  Feeling better  ' });
      assert.equal(res.status, 200);
      assertAppointmentShape(res.body.appointment);
      assert.equal(res.body.appointment.status, 'cancelled');
      assert.equal(res.body.appointment.cancellationReason, 'Feeling better');
      assert.equal(res.body.appointment.startsAt, appointment.startsAt, 'only the status changes');

      const { rows } = await app.db.query('SELECT status FROM appointments WHERE id = $1', [appointment.id]);
      assert.equal(rows[0].status, 'cancelled', 'cancelling keeps the row; it is not a delete');
    });

    it('stores a blank reason as no reason', async () => {
      const { appointment } = (await book(customer, { date: freshDate(), time: '10:00' })).body;
      const res = await cancel(customer, appointment.id, { reason: '   ' });
      assert.equal(res.status, 200);
      assert.equal(res.body.appointment.cancellationReason, null);
    });

    it('accepts a cancellation without a reason', async () => {
      const { appointment } = (await book(customer, { date: freshDate(), time: '10:00' })).body;
      const res = await customer.post(`/api/appointments/${appointment.id}/cancel`);
      assert.equal(res.status, 200);
      assert.equal((res.body as { appointment: AppointmentDto }).appointment.cancellationReason, null);
    });

    it('frees the slot for someone else straight away', async () => {
      const date = freshDate();
      const { appointment } = (await book(customer, { date, time: '10:00' })).body;
      assertApiError(await book(neighbour, { date, time: '10:00' }), 409, 'SLOT_UNAVAILABLE');

      await cancel(customer, appointment.id);

      const rebooked = await book(neighbour, { date, time: '10:00' });
      assert.equal(rebooked.status, 201);
      assert.notEqual(rebooked.body.appointment.id, appointment.id);
    });

    it('treats a second cancellation as a conflict with a clear message, not a success or a crash', async () => {
      const { appointment } = (await book(customer, { date: freshDate(), time: '10:00' })).body;
      assert.equal((await cancel(customer, appointment.id, { reason: 'first' })).status, 200);

      const error = assertApiError(
        await cancel(customer, appointment.id, { reason: 'second' }),
        409,
        'APPOINTMENT_NOT_CANCELLABLE',
      );
      assert.match(error.message, /already cancelled/i);

      const { rows } = await app.db.query('SELECT cancellation_reason FROM appointments WHERE id = $1', [appointment.id]);
      assert.equal(rows[0].cancellation_reason, 'first', 'the original reason is not overwritten');
    });

    it('will not cancel something that is already completed', async () => {
      const error = assertApiError(
        await cancel(customer, 'ffffffff-0000-0000-0000-000000000003'),
        409,
        'APPOINTMENT_NOT_CANCELLABLE',
      );
      assert.match(error.message, /already completed/i);
    });

    it('answers 404 — not 403 or 409 — when someone else’s appointment is targeted, and leaves it alone', async () => {
      const { appointment } = (await book(customer, { date: freshDate(), time: '10:00' })).body;

      // Same tenant, different customer. The response must not reveal that it
      // exists or what state it is in.
      const sameTenant = assertApiError(await cancel(neighbour, appointment.id), 404, 'NOT_FOUND');
      const unknown = assertApiError(
        await cancel(neighbour, '99999999-9999-4999-8999-999999999999'),
        404,
        'NOT_FOUND',
      );
      assert.equal(sameTenant.message, unknown.message);

      // Another tenant entirely.
      assertApiError(await cancel(northside, appointment.id), 404, 'NOT_FOUND');

      const { rows } = await app.db.query('SELECT status FROM appointments WHERE id = $1', [appointment.id]);
      assert.equal(rows[0].status, 'confirmed');
    });

    it('lets staff and owners cancel any appointment in their tenant', async () => {
      const first = (await book(customer, { date: freshDate(), time: '10:00' })).body.appointment;
      const second = (await book(neighbour, { date: freshDate(), time: '10:00' })).body.appointment;

      const byStaff = await cancel(staff, first.id, { reason: 'Clinic closed' });
      assert.equal(byStaff.status, 200);
      assert.equal(byStaff.body.appointment.status, 'cancelled');
      assert.equal(byStaff.body.appointment.cancellationReason, 'Clinic closed');
      assert.equal((await cancel(owner, second.id)).status, 200);
    });

    it('does not let another tenant’s staff cancel it', async () => {
      const { appointment } = (await book(customer, { date: freshDate(), time: '10:00' })).body;
      assertApiError(await cancel(northside, appointment.id), 404, 'NOT_FOUND');
    });

    it('answers 404 for an unknown id and 400 for a malformed one or an over-long reason', async () => {
      assertApiError(await cancel(customer, '99999999-9999-4999-8999-999999999999'), 404, 'NOT_FOUND');
      assertApiError(await cancel(customer, 'not-a-uuid'), 400, 'VALIDATION_FAILED');

      const { appointment } = (await book(customer, { date: freshDate(), time: '10:00' })).body;
      const tooLong = await cancel(customer, appointment.id, { reason: 'x'.repeat(501) });
      assert.deepEqual(Object.keys(assertApiError(tooLong, 400, 'VALIDATION_FAILED').details ?? {}), ['reason']);
    });

    it('requires authentication', async () => {
      const { appointment } = (await book(customer, { date: freshDate(), time: '10:00' })).body;
      assertApiError(await cancel(app.client(), appointment.id), 401, 'UNAUTHENTICATED');
    });
  });

  describe('concurrent bookings', () => {
    it('lets exactly one of ten simultaneous requests for the same slot win', async () => {
      const date = freshDate();
      const clients = [customer, staff, owner, neighbour];
      const attempts = Array.from({ length: 10 }, (_, i) => book(clients[i % clients.length]!, { date, time: '10:00' }));

      const results = await Promise.all(attempts);

      const winners = results.filter((r) => r.status === 201);
      const losers = results.filter((r) => r.status !== 201);
      assert.equal(winners.length, 1, `statuses: ${results.map((r) => r.status).join(',')}`);
      assert.equal(losers.length, 9);
      for (const loser of losers) assertApiError(loser, 409, 'SLOT_UNAVAILABLE');

      const { rows } = await app.db.query(
        `SELECT count(*)::int AS n FROM appointments
         WHERE business_id = $1 AND service_id = $2 AND starts_at = $3`,
        [SEED.bluewave.id, SEED.services.routineCheckup.id, instant(date, '10:00')],
      );
      assert.equal(rows[0].n, 1, 'exactly one row may exist for the slot');
    });

    it('lets exactly one overlapping-but-not-identical request win', async () => {
      const date = freshDate();
      // Four 60-minute bookings whose ranges all overlap 14:30-15:00.
      const times = ['14:00', '14:30', '14:00', '14:30'];
      const results = await Promise.all(
        times.map((time, i) =>
          book([customer, staff, owner, neighbour][i]!, { date, time, serviceId: SEED.services.teethWhitening.id }),
        ),
      );
      assert.equal(results.filter((r) => r.status === 201).length, 1, `statuses: ${results.map((r) => r.status).join(',')}`);
      for (const loser of results.filter((r) => r.status !== 201)) assertApiError(loser, 409, 'SLOT_UNAVAILABLE');

      const { rows } = await app.db.query(
        `SELECT count(*)::int AS n FROM appointments
         WHERE business_id = $1 AND status IN ('pending', 'confirmed') AND starts_at < $3 AND ends_at > $2`,
        [SEED.bluewave.id, instant(date, '14:00'), instant(date, '15:30')],
      );
      assert.equal(rows[0].n, 1, 'exactly one live row may overlap 14:00-15:30');
    });

    it('lets exactly one of several simultaneous cancellations of the same appointment succeed', async () => {
      const { appointment } = (await book(customer, { date: freshDate(), time: '10:00' })).body;
      const results = await Promise.all(
        [customer, staff, owner, customer].map((client) => client.post(`/api/appointments/${appointment.id}/cancel`, {})),
      );
      assert.equal(results.filter((r) => r.status === 200).length, 1);
      for (const loser of results.filter((r) => r.status !== 200)) {
        assertApiError(loser, 409, 'APPOINTMENT_NOT_CANCELLABLE');
      }
    });

    describe('when the availability check cannot see the competing booking', () => {
      /**
       * The service checks availability and then inserts, which leaves a window
       * in which two requests both see a free slot. These tests open that window
       * deliberately: a competing booking is inserted inside an uncommitted
       * transaction, which the availability check cannot see, so the request
       * must be stopped by the EXCLUDE constraint — the real guarantee.
       */
      async function raceAgainstUncommittedBooking(
        date: string,
        outcome: 'COMMIT' | 'ROLLBACK',
        rival: { userId: string; serviceId: string } = { userId: SEED.users.staff.id, serviceId: SEED.services.routineCheckup.id },
      ) {
        const competitor = await app.db.connect();
        try {
          await competitor.query('BEGIN');
          await competitor.query(
            `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
             VALUES ($1, $2, $3, $4, $5, 'confirmed')`,
            [SEED.bluewave.id, rival.userId, rival.serviceId, instant(date, '10:00'), instant(date, '10:30')],
          );

          const request = book(customer, { date, time: '10:00' });

          // Wait until the request's INSERT is parked behind the uncommitted row.
          await eventually(async () => {
            const { rows } = await app.db.query(
              `SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
            );
            return rows.length > 0 || undefined;
          });

          await competitor.query(outcome);
          return await request;
        } finally {
          competitor.release();
        }
      }

      it('turns the lost race into a 409, not a 500', async () => {
        const res = await raceAgainstUncommittedBooking(freshDate(), 'COMMIT');
        const error = assertApiError(res, 409, 'SLOT_UNAVAILABLE');
        assert.match(error.message, /just took/i, 'this must be the constraint path, not the early availability check');
      });

      it('names the customer clash when the competing booking is the same customer’s, for another service', async () => {
        // Only the per-customer constraint can refuse this: the services differ,
        // and the availability check cannot see the uncommitted row.
        const res = await raceAgainstUncommittedBooking(freshDate(), 'COMMIT', {
          userId: SEED.users.customer.id,
          serviceId: SEED.services.emergencyConsult.id,
        });
        const error = assertApiError(res, 409, 'CUSTOMER_BUSY');
        assert.match(error.message, /already have an appointment/);
      });

      it('does not let a booking that was rolled back block the slot', async () => {
        const res = await raceAgainstUncommittedBooking(freshDate(), 'ROLLBACK');
        assert.equal(res.status, 201);
      });
    });
  });
});
