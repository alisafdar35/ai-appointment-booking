import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AvailabilityDto } from '@appt/shared';
import { assertApiError } from '../helpers/assertions.js';
import { book, instant } from '../helpers/booking.js';
import { SEED, addDays, freshDate, futureDate, nextDstTransition } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient } from '../helpers/apiClient.js';
import { nowTimeInZone } from '../../src/lib/time.js';

const HOUR_MS = 3_600_000;

describe('availability', () => {
  let app: TestApp;
  let customer: ApiClient;
  let staff: ApiClient;
  let northside: ApiClient;

  before(async () => {
    app = await startTestApp();
    [customer, staff, northside] = await Promise.all([
      app.loginAs('customer'),
      app.loginAs('staff'),
      app.loginAs('northsideOwner'),
    ]);
  });
  after(async () => {
    await app.stop();
  });

  const slotsFor = async (client: ApiClient, serviceId: string, date: string) => {
    const res = await client.get<{ availability: AvailabilityDto }>(
      `/api/services/${serviceId}/availability?date=${date}`,
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.availability;
  };
  const taken = (a: AvailabilityDto) => a.slots.filter((s) => !s.available).map((s) => s.time);
  const times = (a: AvailabilityDto) => a.slots.map((s) => s.time);

  describe('the slot grid', () => {
    it('offers a 30-minute grid across opening hours, stopping early enough for the service to finish', async () => {
      const date = freshDate();
      const a = await slotsFor(customer, SEED.services.routineCheckup.id, date);

      assert.equal(a.date, date);
      assert.equal(a.serviceId, SEED.services.routineCheckup.id);
      assert.equal(a.durationMinutes, 30);
      assert.equal(a.slots.length, 16);
      assert.equal(a.slots[0]!.time, '09:00');
      assert.equal(a.slots.at(-1)!.time, '16:30', '16:30 + 30 minutes = closing time');
      assert.ok(a.slots.every((s) => /^([01]\d|2[0-3]):[03]0$/.test(s.time)));
      assert.ok(a.slots.every((s) => s.available === true));
    });

    it('shortens the list for longer services, since they must still finish before closing', async () => {
      const date = freshDate();
      const whitening = await slotsFor(customer, SEED.services.teethWhitening.id, date);
      assert.equal(whitening.durationMinutes, 60);
      assert.equal(whitening.slots.at(-1)!.time, '16:00');
      assert.equal(whitening.slots.length, 15);

      const orthodontic = await slotsFor(customer, SEED.services.orthodonticReview.id, date);
      assert.equal(orthodontic.durationMinutes, 45);
      assert.equal(orthodontic.slots.at(-1)!.time, '16:00', '16:15 would fit but is not on the 30-minute grid');
    });

    it('follows the business’s own opening hours', async () => {
      const date = freshDate(SEED.northside.timezone);
      const a = await slotsFor(northside, SEED.services.generalPractice.id, date);
      assert.equal(a.slots[0]!.time, '08:00');
      assert.equal(a.slots.at(-1)!.time, '17:30');
      assert.equal(a.slots.length, 20);
    });
  });

  describe('what a booking blocks', () => {
    it('marks exactly the slots the booking overlaps, and no others', async () => {
      const date = freshDate();
      const whitening = SEED.services.teethWhitening.id;
      await book(customer, { date, time: '14:00', serviceId: whitening }); // occupies 14:00-15:00

      const a = await slotsFor(customer, whitening, date);
      // 13:30 would run to 14:30 and collide; 13:00 ends as it starts; 15:00 starts as it ends.
      assert.deepEqual(taken(a), ['13:30', '14:00', '14:30']);
    });

    it('treats back-to-back slots as free', async () => {
      const date = freshDate();
      await book(customer, { date, time: '10:00' }); // Routine Checkup, 10:00-10:30
      const a = await slotsFor(customer, SEED.services.routineCheckup.id, date);
      assert.deepEqual(taken(a), ['10:00']);
    });

    it('keeps each service’s bookings separate for everyone else', async () => {
      const date = freshDate();
      await book(customer, { date, time: '10:00' });
      const other = await slotsFor(staff, SEED.services.orthodonticReview.id, date);
      assert.deepEqual(taken(other), []);
    });

    it('marks the customer’s own busy times unavailable on every service, since they cannot be in two places', async () => {
      const date = freshDate();
      await book(customer, { date, time: '10:00' }); // Routine Checkup, 10:00-10:30
      // A 45-minute review starting 09:30 would run into it, as would one at 10:00.
      const mine = await slotsFor(customer, SEED.services.orthodonticReview.id, date);
      assert.deepEqual(taken(mine), ['09:30', '10:00']);
    });

    it('ignores cancelled appointments, so a freed slot reappears', async () => {
      const date = freshDate();
      const { appointment } = (await book(customer, { date, time: '11:00' })).body;
      assert.deepEqual(taken(await slotsFor(customer, SEED.services.routineCheckup.id, date)), ['11:00']);

      await customer.post(`/api/appointments/${appointment.id}/cancel`, {});
      assert.deepEqual(taken(await slotsFor(customer, SEED.services.routineCheckup.id, date)), []);
    });

    it('agrees with the booking endpoint about what is free', async () => {
      const date = freshDate();
      const whitening = SEED.services.teethWhitening.id;
      await book(customer, { date, time: '14:00', serviceId: whitening });
      const a = await slotsFor(customer, whitening, date);

      const blocked = a.slots.find((s) => s.time === '13:30' && !s.available);
      const free = a.slots.find((s) => s.time === '15:00' && s.available);
      assert.ok(blocked && free);
      assertApiError(await book(customer, { date, time: blocked.time, serviceId: whitening }), 409, 'SLOT_UNAVAILABLE');
      assert.equal((await book(customer, { date, time: free.time, serviceId: whitening })).status, 201);
    });

    it('never shows another tenant’s bookings', async () => {
      const date = freshDate();
      await book(customer, { date, time: '10:00' });
      const mine = await slotsFor(northside, SEED.services.generalPractice.id, date);
      assert.deepEqual(taken(mine), []);
    });
  });

  describe('time', () => {
    it('reports every slot on a past day as unavailable', async () => {
      const a = await slotsFor(customer, SEED.services.routineCheckup.id, futureDate(-1));
      assert.equal(a.slots.length, 16);
      assert.deepEqual(taken(a), times(a));
    });

    it('reports slots earlier today as unavailable and later ones as free', async () => {
      const today = futureDate(0);
      const nowMinutes = (() => {
        const [h, m] = nowTimeInZone(SEED.bluewave.timezone).split(':').map(Number) as [number, number];
        return h * 60 + m;
      })();
      const a = await slotsFor(customer, SEED.services.routineCheckup.id, today);
      for (const slot of a.slots) {
        const [h, m] = slot.time.split(':').map(Number) as [number, number];
        const slotMinutes = h * 60 + m;
        // A minute either side of "now" is skipped: the clock can tick between the two reads.
        if (Math.abs(slotMinutes - nowMinutes) <= 1) continue;
        assert.equal(slot.available, slotMinutes > nowMinutes, `slot ${slot.time}, now ${nowMinutes}`);
      }
    });
  });

  describe('across daylight saving transitions', () => {
    const NY = SEED.bluewave.timezone;
    const LONDON = SEED.northside.timezone;

    const hoursBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / HOUR_MS;

    it('keeps the same 09:00-17:00 grid on the day New York’s clocks fall back', async () => {
      const date = nextDstTransition(NY, 'fall');
      const a = await slotsFor(customer, SEED.services.routineCheckup.id, date);
      assert.equal(new Date(`${date}T12:00:00Z`).getUTCDay(), 0, 'transition days are Sundays');
      assert.equal(a.slots.length, 16);
      assert.equal(a.slots[0]!.time, '09:00');
      assert.equal(a.slots.at(-1)!.time, '16:30');
      assert.deepEqual(taken(a), []);
    });

    it('books wall-clock times correctly either side of the New York fall-back, and the day is 25 hours long', async () => {
      const fall = nextDstTransition(NY, 'fall');
      const dayBefore = addDays(fall, -1);

      const before = (await book(customer, { date: dayBefore, time: '09:00' })).body.appointment;
      const onDay = (await book(customer, { date: fall, time: '09:00' })).body.appointment;
      const afterwards = (await book(customer, { date: addDays(fall, 1), time: '09:00' })).body.appointment;

      // EDT (UTC-4) before the change, EST (UTC-5) from it.
      assert.equal(before.startsAt, instant(dayBefore, '09:00', NY));
      assert.equal(before.startsAt.slice(11, 16), '13:00');
      assert.equal(onDay.startsAt.slice(11, 16), '14:00');
      assert.equal(afterwards.startsAt.slice(11, 16), '14:00');
      assert.equal(hoursBetween(before.startsAt, onDay.startsAt), 25);
      assert.equal(hoursBetween(onDay.startsAt, afterwards.startsAt), 24);

      // The booking lands on the right slot of the right local day.
      assert.deepEqual(taken(await slotsFor(customer, SEED.services.routineCheckup.id, fall)), ['09:00']);
      assert.deepEqual(taken(await slotsFor(customer, SEED.services.routineCheckup.id, dayBefore)), ['09:00']);
    });

    it('keeps the end of a booking exactly one service-duration after its start on a transition day', async () => {
      const fall = nextDstTransition(NY, 'fall');
      const a = (await book(customer, { date: fall, time: '16:00', serviceId: SEED.services.teethWhitening.id })).body.appointment;
      assert.equal(hoursBetween(a.startsAt, a.endsAt), 1);
      assert.equal(a.endsAt.slice(11, 16), '22:00', '17:00 EST is 22:00Z');
    });

    it('treats a slot that would end at closing time on the New York fall-back day as bookable', async () => {
      const fall = nextDstTransition(NY, 'fall');
      // Staff, because the customer already holds 16:00-17:00 on this day (above).
      const res = await book(staff, { date: fall, time: '16:30' });
      assert.equal(res.status, 201);
      assert.equal(res.body.appointment.endsAt.slice(11, 16), '22:00');
    });

    it('books wall-clock times correctly either side of the New York spring-forward, and the day is 23 hours long', async () => {
      const spring = nextDstTransition(NY, 'spring');
      const dayBefore = addDays(spring, -1);

      const before = (await book(customer, { date: dayBefore, time: '09:00' })).body.appointment;
      const onDay = (await book(customer, { date: spring, time: '09:00' })).body.appointment;

      // EST (UTC-5) before the change, EDT (UTC-4) from it.
      assert.equal(before.startsAt.slice(11, 16), '14:00');
      assert.equal(onDay.startsAt.slice(11, 16), '13:00');
      assert.equal(hoursBetween(before.startsAt, onDay.startsAt), 23);
      assert.deepEqual(taken(await slotsFor(customer, SEED.services.routineCheckup.id, spring)), ['09:00']);
    });

    it('keeps the 08:00-18:00 grid on the day London’s clocks fall back, and books in local time', async () => {
      const fall = nextDstTransition(LONDON, 'fall');
      const dayBefore = addDays(fall, -1);
      const gp = SEED.services.generalPractice.id;

      const a = await slotsFor(northside, gp, fall);
      assert.equal(a.slots.length, 20);
      assert.equal(a.slots[0]!.time, '08:00');
      assert.deepEqual(taken(a), []);

      const before = (await book(northside, { date: dayBefore, time: '09:00', serviceId: gp })).body.appointment;
      const onDay = (await book(northside, { date: fall, time: '09:00', serviceId: gp })).body.appointment;

      // BST (UTC+1) before the change, GMT (UTC+0) from it.
      assert.equal(before.startsAt.slice(11, 16), '08:00');
      assert.equal(onDay.startsAt.slice(11, 16), '09:00');
      assert.equal(hoursBetween(before.startsAt, onDay.startsAt), 25);
      assert.deepEqual(taken(await slotsFor(northside, gp, fall)), ['09:00']);
      assert.deepEqual(taken(await slotsFor(northside, gp, dayBefore)), ['09:00']);
    });

    it('books in local time on the day London’s clocks spring forward', async () => {
      const spring = nextDstTransition(LONDON, 'spring');
      const gp = SEED.services.generalPractice.id;
      const before = (await book(northside, { date: addDays(spring, -1), time: '09:00', serviceId: gp })).body.appointment;
      const onDay = (await book(northside, { date: spring, time: '09:00', serviceId: gp })).body.appointment;

      // GMT before the change, BST from it.
      assert.equal(before.startsAt.slice(11, 16), '09:00');
      assert.equal(onDay.startsAt.slice(11, 16), '08:00');
      assert.equal(hoursBetween(before.startsAt, onDay.startsAt), 23);
    });
  });

  describe('request handling', () => {
    const date = () => futureDate(30);

    it('requires authentication', async () => {
      const res = await app.client().get(`/api/services/${SEED.services.routineCheckup.id}/availability?date=${date()}`);
      assertApiError(res, 401, 'UNAUTHENTICATED');
    });

    it('requires a valid date', async () => {
      const path = `/api/services/${SEED.services.routineCheckup.id}/availability`;
      assert.deepEqual(
        Object.keys(assertApiError(await customer.get(path), 400, 'VALIDATION_FAILED').details ?? {}),
        ['date'],
      );
      for (const bad of ['tomorrow', '2031-1-5', '05-10-2031', '2031-13-01']) {
        assertApiError(await customer.get(`${path}?date=${bad}`), 400, 'VALIDATION_FAILED');
      }
    });

    it('rejects a day that does not exist with a 400 rather than a server error', async () => {
      const res = await customer.get(`/api/services/${SEED.services.routineCheckup.id}/availability?date=2031-02-31`);
      assertApiError(res, 400, 'VALIDATION_FAILED');
    });

    it('rejects a service id that is not a uuid', async () => {
      assertApiError(await customer.get(`/api/services/routine/availability?date=${date()}`), 400, 'VALIDATION_FAILED');
    });

    it('answers 404 for an unknown service, another tenant’s service, or a retired one', async () => {
      const missing = '99999999-9999-4999-8999-999999999999';
      assertApiError(await customer.get(`/api/services/${missing}/availability?date=${date()}`), 404, 'NOT_FOUND');
      assertApiError(
        await customer.get(`/api/services/${SEED.services.generalPractice.id}/availability?date=${date()}`),
        404,
        'NOT_FOUND',
      );
      assertApiError(
        await northside.get(`/api/services/${SEED.services.routineCheckup.id}/availability?date=${date()}`),
        404,
        'NOT_FOUND',
      );

      const { rows } = await app.db.query<{ id: string }>(
        `INSERT INTO services (business_id, name, duration_minutes, is_active)
         VALUES ($1, 'Retired Treatment', 30, false) RETURNING id`,
        [SEED.bluewave.id],
      );
      assertApiError(await customer.get(`/api/services/${rows[0]!.id}/availability?date=${date()}`), 404, 'NOT_FOUND');
    });
  });

  describe('the service catalogue', () => {
    it('lists only the caller’s tenant’s active services', async () => {
      const mine = await customer.get<{ services: { id: string; name: string; durationMinutes: number; priceCents: number }[] }>(
        '/api/services',
      );
      assert.equal(mine.status, 200);
      assert.deepEqual(
        mine.body.services.map((s) => s.name),
        ['Emergency Consult', 'Orthodontic Review', 'Routine Checkup', 'Teeth Whitening'],
      );
      assert.deepEqual(mine.body.services.find((s) => s.name === 'Teeth Whitening'), {
        id: SEED.services.teethWhitening.id,
        name: 'Teeth Whitening',
        description: 'Professional in-chair whitening.',
        durationMinutes: 60,
        priceCents: 24000,
      });

      const theirs = await northside.get<{ services: { name: string }[] }>('/api/services');
      assert.deepEqual(theirs.body.services.map((s) => s.name), ['General Practice']);
    });

    it('requires authentication', async () => {
      assertApiError(await app.client().get('/api/services'), 401, 'UNAUTHENTICATED');
    });
  });
});
