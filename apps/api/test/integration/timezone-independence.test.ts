import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AppointmentDto, AvailabilityDto } from '@appt/shared';
import { book, instant } from '../helpers/booking.js';
import { SEED, freshDate } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient } from '../helpers/apiClient.js';

/**
 * A booking's instant depends on the business's timezone and nothing else.
 *
 * This file runs the API with the Node process in UTC+14 and every database
 * session in UTC+5:45 (via PGOPTIONS, which node-postgres reads), and the
 * client claims yet another zone. If any of the three leaked into the
 * conversion, 10:00 in New York would be stored as some other instant.
 */
describe('timezone independence', () => {
  let app: TestApp;
  let customer: ApiClient;

  before(async () => {
    app = await startTestApp({ env: { TZ: 'Pacific/Kiritimati', PGOPTIONS: '-c TimeZone=Asia/Kathmandu' } });
    customer = await app.loginAs('customer');
  });
  after(async () => {
    await app.stop();
  });

  it('runs where it claims to: the process and the database sessions are far from New York', async () => {
    assert.equal(new Date('2026-01-01T00:00:00Z').getTimezoneOffset(), -14 * 60);
    const { rows } = await app.db.query('SHOW TimeZone');
    assert.equal(rows[0].TimeZone, 'Asia/Kathmandu');
  });

  it('stores the business-local wall time as the same instant, whatever zone the client says it is in', async () => {
    const date = freshDate();
    const res = await book(customer, { date, time: '10:00' });
    assert.equal(res.status, 201);
    const { appointment } = res.body;
    assert.equal(appointment.startsAt, instant(date, '10:00', SEED.bluewave.timezone));

    // A client in Tokyo asking for the same wall time is told it is taken: it is the same slot.
    const tokyo = await customer.post(
      '/api/appointments',
      { serviceId: SEED.services.routineCheckup.id, date, time: '10:00' },
      { headers: { 'Accept-Language': 'ja-JP', 'Time-Zone': 'Asia/Tokyo' } },
    );
    assert.equal(tokyo.status, 409);

    // Read back as UTC ISO, which any client renders in the business zone to the same 10:00.
    const read = await customer.get<{ appointment: AppointmentDto }>(`/api/appointments/${appointment.id}`);
    assert.equal(read.body.appointment.startsAt, appointment.startsAt);
    const shown = new Intl.DateTimeFormat('en-GB', {
      timeZone: SEED.bluewave.timezone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(read.body.appointment.startsAt));
    assert.equal(shown, '10:00');
  });

  it('builds the availability grid and the opening-hours check on the business clock', async () => {
    const date = freshDate();
    const res = await customer.get<{ availability: AvailabilityDto }>(
      `/api/services/${SEED.services.routineCheckup.id}/availability?date=${date}`,
    );
    const times = res.body.availability.slots.map((s) => s.time);
    assert.equal(times[0], '09:00');
    assert.equal(times.at(-1), '16:30');
    assert.equal((await book(customer, { date, time: '09:00' })).status, 201);
    assert.equal((await book(customer, { date, time: '08:30' })).status, 422);
  });
});
