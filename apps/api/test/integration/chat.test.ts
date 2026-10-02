import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AssistantTurnDto, ChatSessionDto, ChatTranscriptDto } from '@appt/shared';
import { assertApiError, eventually, isUuid } from '../helpers/assertions.js';
import { book, instant } from '../helpers/booking.js';
import { pinToday } from '../helpers/clock.js';
import { SEED, addDays, freshDate, futureDate, pastDate } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient, ApiResponse } from '../helpers/apiClient.js';
import { shortDate } from '../../src/lib/time.js';

type Transcript = ChatTranscriptDto;

/**
 * End-to-end conversations on the deterministic engine (no MISTRAL_API_KEY),
 * which is the engine every reviewer without a key will actually meet.
 *
 * Dates are written into messages as ISO dates ("on 2031-04-22 at 10am") where
 * a test needs a specific slot: relative dates ("next monday") are kept to the
 * tests about them. The app's "today" is pinned (TEST_TODAY, helpers/clock.ts)
 * so those read the same on any day the suite runs.
 */
const today = pinToday();
const weekdayName = (date: string) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

describe('chat', () => {
  let app: TestApp;
  let customer: ApiClient;
  let staff: ApiClient;
  let owner: ApiClient;
  let northside: ApiClient;

  before(async () => {
    app = await startTestApp();
    [customer, staff, owner, northside] = await Promise.all([
      app.loginAs('customer'),
      app.loginAs('staff'),
      app.loginAs('owner'),
      app.loginAs('northsideOwner'),
    ]);
  });
  after(async () => {
    await app.stop();
  });

  const say = (client: ApiClient, content: string, sessionId?: string): Promise<ApiResponse<AssistantTurnDto>> =>
    client.post('/api/chat/messages', { content, ...(sessionId ? { sessionId } : {}) });

  /** Send a message and assert it was accepted. */
  async function turn(client: ApiClient, content: string, sessionId?: string): Promise<AssistantTurnDto> {
    const res = await say(client, content, sessionId);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  const appointmentsFor = async (sessionId: string) =>
    (await app.db.query('SELECT * FROM appointments WHERE chat_session_id = $1', [sessionId])).rows;

  describe('a booking conversation', () => {
    it('collects the details over several turns, asks for confirmation, then books', async () => {
      // Turn 1: only the service.
      const first = await say(customer, 'I need a routine checkup');
      assert.equal(first.status, 201);
      const t1 = first.body;
      assert.ok(isUuid(t1.sessionId));
      assert.equal(t1.action, 'collect_info');
      assert.equal(t1.engine, 'fallback');
      assert.deepEqual(t1.bookingDraft, { serviceName: 'Routine Checkup', date: null, time: null, notes: null });
      assert.deepEqual(t1.missing, ['date', 'time']);
      assert.equal(t1.message.role, 'assistant');
      assert.equal(t1.message.engine, 'fallback');
      assert.match(t1.message.content, /day and time/i);
      assert.equal(t1.appointment, undefined);

      // Turn 2: a relative date and a time resolve against the business calendar.
      // (4pm: the seeded bookings this customer already holds are at 10:00 and 14:00.)
      const t2 = await turn(customer, 'next monday at 4pm', t1.sessionId);
      assert.equal(t2.sessionId, t1.sessionId, 'the conversation continues in one session');
      assert.equal(t2.action, 'confirm');
      assert.deepEqual(t2.missing, []);
      assert.equal(t2.bookingDraft.serviceName, 'Routine Checkup', 'earlier details are kept');
      assert.equal(t2.bookingDraft.time, '16:00');
      const date = t2.bookingDraft.date!;
      assert.equal(new Date(`${date}T12:00:00Z`).getUTCDay(), 1, 'a Monday');
      assert.ok(date > futureDate(0) && date <= futureDate(14), `${date} should be within the next two weeks`);
      assert.match(t2.message.content, /Shall I book it\?/);
      assert.deepEqual(await appointmentsFor(t1.sessionId), [], 'nothing is written before the user agrees');

      // Turn 3: agreement creates the appointment.
      const t3 = await turn(customer, 'yes', t1.sessionId);
      assert.equal(t3.action, 'booked');
      assert.match(t3.message.content, /^Booked — Routine Checkup on Monday, \w+ \d+, \d{4} at 4:00 PM/);
      const a = t3.appointment!;
      assert.equal(a.status, 'confirmed');
      assert.equal(a.source, 'chat');
      assert.equal(a.chatSessionId, t1.sessionId);
      assert.equal(a.service.name, 'Routine Checkup');
      assert.equal(a.customer.id, SEED.users.customer.id);
      assert.equal(a.startsAt, instant(date, '16:00'));

      // The appointment row really exists and points back at the conversation.
      const rows = await appointmentsFor(t1.sessionId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, a.id);
      assert.equal(rows[0].source, 'chat');

      // The session is marked complete and titled after what was booked, in words a person reads.
      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t1.sessionId}`);
      assert.equal(body.session.status, 'completed');
      assert.equal(body.session.title, `Routine Checkup — ${shortDate(date)}`);
      assert.equal(body.session.messageCount, 6);
      assert.deepEqual(
        body.messages.map((m) => m.role),
        ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
      );
      assert.equal(body.messages[0]!.content, 'I need a routine checkup');

      // And the appointment shows up on the dashboard like any other.
      const list = await customer.get<{ appointments: { id: string }[] }>('/api/appointments?limit=100');
      assert.ok(list.body.appointments.some((x) => x.id === a.id));
    });

    it('never books on the first message, even when it says "book" and names everything', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `Please book a routine checkup on ${date} at 10am`);
      assert.equal(t1.action, 'confirm', 'the user has not yet seen the summary');
      assert.equal(t1.appointment, undefined);
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);

      const t2 = await turn(customer, 'yes', t1.sessionId);
      assert.equal(t2.action, 'booked');
      assert.equal((await appointmentsFor(t1.sessionId)).length, 1);
    });

    it('does not treat "yes" as consent when there is nothing to confirm', async () => {
      const t1 = await turn(customer, 'yes');
      assert.equal(t1.action, 'collect_info');
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);

      const t2 = await turn(customer, 'yes, a routine checkup', t1.sessionId);
      assert.equal(t2.action, 'collect_info', 'the service alone is not a complete booking');
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('does not book a detail the user changed in the same breath as agreeing', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      assert.equal(t1.action, 'confirm');

      // "yes, but 4pm" agrees to something the user has not been shown.
      const t2 = await turn(customer, 'yes, but make it 4pm', t1.sessionId);
      assert.equal(t2.action, 'confirm');
      assert.equal(t2.bookingDraft.time, '16:00');
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);

      const t3 = await turn(customer, 'yes', t1.sessionId);
      assert.equal(t3.action, 'booked');
      assert.equal(t3.appointment!.startsAt, instant(date, '16:00'));
    });

    it('does not book when the user says not to, even in words that mention booking', async () => {
      for (const refusal of ["don't book it", 'wait, do not book it yet']) {
        const t1 = await turn(customer, `routine checkup on ${freshDate()} at 10am`);
        assert.equal(t1.action, 'confirm');
        const t2 = await turn(customer, refusal, t1.sessionId);
        assert.notEqual(t2.action, 'booked', refusal);
        assert.deepEqual(await appointmentsFor(t1.sessionId), [], refusal);
      }
    });

    it('does not book when the user declines', async () => {
      const t1 = await turn(customer, `routine checkup on ${freshDate()} at 10am`);
      const t2 = await turn(customer, 'no, a different day please', t1.sessionId);
      assert.notEqual(t2.action, 'booked');
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('keeps the other details when the user corrects one mid-conversation', async () => {
      const t1 = await turn(customer, 'routine checkup tomorrow at 2pm');
      assert.equal(t1.action, 'confirm');
      const tomorrow = addDays(futureDate(0), 1);
      assert.deepEqual(t1.bookingDraft, { serviceName: 'Routine Checkup', date: tomorrow, time: '14:00', notes: null });

      const t2 = await turn(customer, 'actually 3pm', t1.sessionId);
      assert.equal(t2.action, 'confirm', 'still complete, so it asks again');
      assert.deepEqual(t2.bookingDraft, { serviceName: 'Routine Checkup', date: tomorrow, time: '15:00', notes: null });
      assert.match(t2.message.content, /3:00 PM/);

      const t3 = await turn(customer, 'actually make it whitening', t1.sessionId);
      assert.deepEqual(t3.bookingDraft, { serviceName: 'Teeth Whitening', date: tomorrow, time: '15:00', notes: null });
      assert.equal(t3.action, 'confirm');
    });

    it('replaces the date and time on "Actually, make it Wednesday at 2 PM." and asks again before booking', async () => {
      const date = freshDate();
      // A weekday two days out: today's own weekday would be asked about (today or next week?).
      const day = addDays(today, 2);
      const weekday = weekdayName(day);
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      assert.equal(t1.action, 'confirm');

      const t2 = await turn(customer, `Actually, make it ${weekday} at 2 PM.`, t1.sessionId);
      assert.equal(t2.action, 'confirm');
      assert.deepEqual(t2.bookingDraft, { serviceName: 'Routine Checkup', date: day, time: '14:00', notes: null });
      assert.match(t2.message.content, new RegExp(`${weekday}, .* at 2:00 PM\\. Shall I book it\\?`));
      assert.equal(t2.appointment, undefined);
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('takes "Book a consultation tomorrow at 10 AM." as a day and time, invents no service, and lists the real ones', async () => {
      const t = await turn(customer, 'Book a consultation tomorrow at 10 AM.');
      assert.equal(t.action, 'collect_info');
      assert.deepEqual(t.bookingDraft, { serviceName: null, date: addDays(today, 1), time: '10:00', notes: null });
      assert.match(t.message.content, /Which service would you like\? We offer: Emergency Consult, Orthodontic Review, Routine Checkup, Teeth Whitening/);
      assert.deepEqual(await appointmentsFor(t.sessionId), []);
    });

    it('says a service the business does not offer is not offered, and lists the ones it does', async () => {
      const date = freshDate();
      const t = await turn(customer, `I'd like a haircut on ${date} at 11am`);
      assert.equal(t.action, 'collect_info');
      assert.deepEqual(t.bookingDraft, { serviceName: null, date, time: '11:00', notes: null }, 'the day and time are kept');
      assert.match(t.message.content, /^We don't offer that\./);
      assert.match(t.message.content, /Emergency Consult, Orthodontic Review, Routine Checkup, Teeth Whitening/);
      assert.deepEqual(await appointmentsFor(t.sessionId), []);
    });

    /** A refusal in place of the summary: nothing to say "yes" to. */
    const assertRefusedBeforeSummary = (t: AssistantTurnDto) => {
      assert.equal(t.action, 'collect_info', 'no summary is shown for a slot the booking would refuse');
      assert.ok(!/Just to confirm|Shall I book it/.test(t.message.content), t.message.content);
      assert.equal(t.appointment, undefined);
    };

    it('refuses a taken slot before showing a summary, offers real alternatives, and lets the user pick one', async () => {
      const date = freshDate();
      assert.equal((await book(staff, { date, time: '10:00' })).status, 201);

      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);

      assertRefusedBeforeSummary(t1);
      assert.match(t1.message.content, /already booked/i);
      assert.equal(t1.bookingDraft.time, null, 'the dead time is dropped so it is not proposed again');
      assert.equal(t1.bookingDraft.date, date);
      assert.equal(t1.bookingDraft.serviceName, 'Routine Checkup');
      assert.deepEqual(t1.missing, ['time']);

      const suggestions = t1.suggestions!;
      assert.equal(suggestions.length, 3);
      assert.deepEqual(
        suggestions.slice(0, 2).map((s) => s.time),
        ['09:30', '10:30'],
        'nearest to the requested time first',
      );
      for (const s of suggestions) {
        assert.equal(s.date, date);
        assert.notEqual(s.time, '10:00');
        assert.match(s.label, /^\d{1,2}:\d{2} (AM|PM)$/);
        assert.ok(t1.message.content.includes(s.label), `the reply names ${s.label}`);
      }
      // Every suggestion really is free.
      const free = await customer.get<{ availability: { slots: { time: string; available: boolean }[] } }>(
        `/api/services/${SEED.services.routineCheckup.id}/availability?date=${date}`,
      );
      for (const s of suggestions) {
        assert.equal(free.body.availability.slots.find((slot) => slot.time === s.time)?.available, true);
      }

      // The user picks one of them and the conversation carries on.
      const t2 = await turn(customer, '9:30am', t1.sessionId);
      assert.equal(t2.action, 'confirm');
      const t3 = await turn(customer, 'yes', t1.sessionId);
      assert.equal(t3.action, 'booked');
      assert.equal(t3.appointment!.startsAt, instant(date, '09:30'));
    });

    it('still checks on "yes": a slot taken after the summary was shown is refused, not double-booked', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      assert.equal(t1.action, 'confirm');
      assert.equal((await book(staff, { date, time: '10:00' })).status, 201);

      const t2 = await turn(customer, 'yes', t1.sessionId);
      assert.equal(t2.action, 'collect_info');
      assert.match(t2.message.content, /already booked/i);
      assert.equal(t2.suggestions!.length, 3);
      assert.equal(t2.bookingDraft.time, null);
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('refuses a time that clashes with the customer’s own booking, and offers times they are free', async () => {
      const date = freshDate();
      // The customer is in the whitening chair 10:00-11:00; the checkup itself is free at 10:30.
      assert.equal((await book(customer, { date, time: '10:00', serviceId: SEED.services.teethWhitening.id })).status, 201);

      const t1 = await turn(customer, `routine checkup on ${date} at 10:30am`);

      assertRefusedBeforeSummary(t1);
      assert.match(t1.message.content, /already have an appointment at that time/i);
      assert.equal(t1.bookingDraft.time, null);
      const offered = t1.suggestions!.map((s) => s.time);
      assert.ok(offered.length > 0);
      for (const time of ['10:00', '10:30']) {
        assert.ok(!offered.includes(time), `${time} overlaps the customer's own booking and must not be offered`);
      }
    });

    it('refuses a time off the half-hour grid and offers the nearest ones on it', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 2:10pm`);

      assertRefusedBeforeSummary(t1);
      assert.match(t1.message.content, /on the hour or half hour/);
      assert.equal(t1.bookingDraft.time, null);
      assert.deepEqual(t1.suggestions!.slice(0, 2).map((s) => s.time), ['14:00', '14:30']);
    });

    it('rolls suggestions over to the next day when the whole day is gone', async () => {
      const date = freshDate();
      // Fill every Routine Checkup slot on the day.
      for (let hour = 9; hour < 17; hour += 1) {
        for (const minute of ['00', '30']) {
          const res = await book(staff, { date, time: `${String(hour).padStart(2, '0')}:${minute}` });
          assert.equal(res.status, 201);
        }
      }
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      assertRefusedBeforeSummary(t1);
      assert.ok(t1.suggestions!.length > 0);
      assert.ok(t1.suggestions!.every((s) => s.date > date));
      assert.match(t1.suggestions![0]!.label, /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/, 'a different day is named in the label');
    });

    it('explains opening hours instead of summarising a time outside them, and keeps the day', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 4:30pm`);
      assert.equal(t1.action, 'confirm', '4:30 PM starts inside opening hours');

      const t2 = await turn(customer, 'make it 8pm instead', t1.sessionId);
      assertRefusedBeforeSummary(t2);
      assert.match(t2.message.content, /^We're open 9:00 AM to 5:00 PM\. Please choose a time inside those hours\. What other time would suit you\?$/);
      assert.deepEqual(t2.bookingDraft, { serviceName: 'Routine Checkup', date, time: null, notes: null });

      // The summary that was on screen is gone, so a "yes" now books nothing.
      const t3 = await turn(customer, 'yes', t1.sessionId);
      assert.notEqual(t3.action, 'booked');
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('does not summarise, or book, a time that has already passed', async () => {
      const t1 = await turn(customer, `routine checkup on ${pastDate(2)} at 10am`);
      assertRefusedBeforeSummary(t1);
      assert.match(t1.message.content, /already passed/);
      assert.equal(t1.bookingDraft.date, null, 'a past day is dropped with its time');
      const t2 = await turn(customer, 'yes', t1.sessionId);
      assert.notEqual(t2.action, 'booked');
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('answers "Can you confirm the price first?" and shows the summary again, without booking', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `teeth whitening on ${date} at 11am`);
      assert.equal(t1.action, 'confirm');
      const t2 = await turn(customer, 'Can you confirm the price first?', t1.sessionId);

      assert.equal(t2.action, 'confirm');
      assert.match(t2.message.content, /^Teeth Whitening takes 60 minutes and costs \$240\.00\. Just to confirm: Teeth Whitening .* Shall I book it\?$/);
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);

      const t3 = await turn(customer, 'yes, but make it 3pm', t1.sessionId);
      assert.equal(t3.action, 'confirm', 'a change is shown again, not booked');
      assert.equal(t3.bookingDraft.time, '15:00');
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('treats a cancellation request as out of scope for booking and points to the dashboard', async () => {
      const t = await turn(customer, 'I want to cancel my appointment');
      assert.equal(t.action, 'collect_info');
      assert.match(t.message.content, /dashboard/i);
    });

    it('books once when the same confirmation arrives several times at once', async () => {
      const t1 = await turn(customer, `routine checkup on ${freshDate()} at 10am`);
      const replies = await Promise.all(Array.from({ length: 4 }, () => say(customer, 'yes', t1.sessionId)));

      // A reply that arrives after the booking finds the conversation closed;
      // one that raced past that check loses at the database instead.
      for (const r of replies.filter((r) => r.status !== 201)) assertApiError(r, 409, 'SESSION_CLOSED');
      assert.equal(replies.filter((r) => r.status === 201 && r.body.action === 'booked').length, 1);
      assert.equal((await appointmentsFor(t1.sessionId)).length, 1, 'the slot is held by exactly one appointment');
    });

    it('says nothing was booked on "Don’t book anything yet." and keeps the details for later', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      const t2 = await turn(customer, 'Don’t book anything yet.', t1.sessionId);
      assert.equal(t2.action, 'confirm');
      assert.match(t2.message.content, /^Okay, I haven't booked anything\. I've kept Routine Checkup on .* at 10:00 AM/);
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);

      const t3 = await turn(customer, 'yes', t1.sessionId);
      assert.equal(t3.action, 'booked', 'agreeing later needs nothing re-typed');
    });

    it('asks for the service, day and time on "I want an appointment."', async () => {
      const t = await turn(customer, 'I want an appointment.');
      assert.equal(t.action, 'collect_info');
      assert.deepEqual(t.missing, ['serviceName', 'date', 'time']);
      assert.match(t.message.content, /Which service would you like, and what day and time suit you\? We offer: /);
    });

    it('asks AM or PM for "At 5." rather than guess, and reopens a time already on screen', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      assert.equal(t1.action, 'confirm');

      const t2 = await turn(customer, 'At 5.', t1.sessionId);
      assert.equal(t2.action, 'collect_info');
      assert.equal(t2.bookingDraft.time, null);
      assert.match(t2.message.content, /Did you mean 5:00 AM or 5:00 PM\? We're open 9:00 AM to 5:00 PM/);

      const t3 = await turn(customer, 'yes', t1.sessionId);
      assert.notEqual(t3.action, 'booked', 'the 10:00 the user moved away from cannot be agreed to');
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);

      const t4 = await turn(customer, '3pm', t1.sessionId);
      assert.equal(t4.action, 'confirm');
      assert.equal(t4.bookingDraft.time, '15:00');
    });

    it('asks which date "03/04" means rather than guess', async () => {
      const t = await turn(customer, 'routine checkup, book for 03/04');
      assert.equal(t.bookingDraft.date, null);
      assert.match(t.message.content, /Did you mean \w+, March 4, \d{4} or \w+, April 3, \d{4}\?/);
    });

    it('asks whether today’s weekday means today or a week today while both are open', async () => {
      // The pinned clock reads 10:00 on `today`, so today still has times left.
      const t = await turn(customer, `routine checkup on ${weekdayName(today)} at 2pm`);
      assert.equal(t.action, 'collect_info');
      assert.equal(t.bookingDraft.date, null);
      assert.equal(t.bookingDraft.time, '14:00');
      assert.match(t.message.content, new RegExp(`Did you mean ${weekdayName(today)}, .* or ${weekdayName(today)}, .*\\?`));
    });

    it('does not ask about today’s weekday when the business is closed that weekday: it names the closed day', async () => {
      const isoWeekday = ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      await app.db.query('UPDATE businesses SET open_days = $2 WHERE id = $1', [
        SEED.bluewave.id,
        [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== isoWeekday),
      ]);
      try {
        const t = await turn(customer, `routine checkup on ${weekdayName(today)} at 2pm`);
        assert.doesNotMatch(t.message.content, /Did you mean/);
        assert.equal(t.action, 'collect_info');
        assert.match(t.message.content, new RegExp(`^We're closed on ${weekdayName(today)}s\\.`));
        assert.equal(t.bookingDraft.date, null);
      } finally {
        await app.db.query('UPDATE businesses SET open_days = $2 WHERE id = $1', [SEED.bluewave.id, [1, 2, 3, 4, 5, 6, 7]]);
      }
    });

    it('takes rapid messages one at a time, in order, without one undoing another', async () => {
      const t1 = await turn(customer, 'hello');
      const date = freshDate();
      // Sent together, each fills a different detail. Run concurrently, every
      // turn would start from the empty draft and the last write would win.
      const replies = await Promise.all(
        ['a routine checkup', `on ${date}`, 'at 10am'].map((text) => say(customer, text, t1.sessionId)),
      );
      for (const r of replies) assert.equal(r.status, 201);

      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t1.sessionId}`);
      assert.deepEqual(body.session.bookingDraft, { serviceName: 'Routine Checkup', date, time: '10:00', notes: null });
      assert.deepEqual(
        body.messages.map((m) => m.role),
        ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
        'each reply directly follows the message it answers',
      );
      // Arrival order is the order the turns ran in: each saw the previous one's draft.
      const drafts = replies.map((r) => r.body.bookingDraft);
      const filled = drafts.map((d) => [d.serviceName, d.date, d.time].filter(Boolean).length).sort();
      assert.deepEqual(filled, [1, 2, 3]);
    });

    it('books once per conversation when chat "yes", the booking form and the draft form race (20 rounds)', async () => {
      for (let round = 0; round < 20; round += 1) {
        const date = freshDate();
        const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
        assert.equal(t1.action, 'confirm');

        // Different times, so no slot or customer overlap decides the race:
        // only the one-booking-per-conversation rule can.
        const replies = await Promise.all([
          say(customer, 'yes', t1.sessionId),
          book(customer, { date, time: '12:00', chatSessionId: t1.sessionId }),
          customer.post<AssistantTurnDto>('/api/chat/draft', {
            sessionId: t1.sessionId,
            slots: { serviceName: 'Routine Checkup', date, time: '14:00' },
          }),
        ]);

        const live = (
          await app.db.query(`SELECT id FROM appointments WHERE chat_session_id = $1 AND status IN ('pending', 'confirmed')`, [
            t1.sessionId,
          ])
        ).rows;
        assert.equal(live.length, 1, `round ${round}: exactly one live appointment for the conversation`);
        assert.equal(replies.filter((r) => r.status === 201 && ('appointment' in r.body)).length, 1, `round ${round}: one winner`);
        for (const r of replies.filter((r) => r.status !== 201)) assertApiError(r, 409, 'SESSION_CLOSED');
        const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t1.sessionId}`);
        assert.equal(body.session.status, 'completed');
      }
    });

    it('refuses a form booking that names a conversation which has already booked', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      assert.equal((await turn(customer, 'yes', t1.sessionId)).action, 'booked');
      assertApiError(await book(customer, { date, time: '15:00', chatSessionId: t1.sessionId }), 409, 'SESSION_CLOSED');
      assert.equal((await appointmentsFor(t1.sessionId)).length, 1);
    });

    it('stays closed after its booking is cancelled: the form and the draft form cannot book into it again', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      const booked = await turn(customer, 'yes', t1.sessionId);
      assert.equal(booked.action, 'booked');
      const cancel = await customer.post(`/api/appointments/${booked.appointment!.id}/cancel`, {});
      assert.equal(cancel.status, 200);

      // The cancelled row no longer holds the one-per-conversation index, so
      // only the conversation's own status stands in the way now.
      assertApiError(await book(customer, { date, time: '15:00', chatSessionId: t1.sessionId }), 409, 'SESSION_CLOSED');
      assertApiError(
        await customer.post('/api/chat/draft', {
          sessionId: t1.sessionId,
          slots: { serviceName: 'Routine Checkup', date, time: '16:00' },
        }),
        409,
        'SESSION_CLOSED',
      );
      const live = await app.db.query(`SELECT 1 FROM appointments WHERE chat_session_id = $1 AND status <> 'cancelled'`, [
        t1.sessionId,
      ]);
      assert.equal(live.rowCount, 0);
    });

    it('refuses a day the business is closed before summarising it, forgets that day, and asks for another', async () => {
      const date = freshDate();
      const isoWeekday = ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      await app.db.query('UPDATE businesses SET open_days = $2 WHERE id = $1', [
        SEED.bluewave.id,
        [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== isoWeekday),
      ]);
      try {
        const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
        assertRefusedBeforeSummary(t1);
        assert.match(t1.message.content, /We're closed on \w+s\./);
        assert.ok(t1.suggestions?.length, 'open days are offered instead');
        assert.equal(t1.bookingDraft.date, null, 'the closed day is not retried on the next turn');
        assert.equal(t1.bookingDraft.time, null);
        assert.equal(t1.bookingDraft.serviceName, 'Routine Checkup');
        assert.deepEqual(await appointmentsFor(t1.sessionId), []);
      } finally {
        await app.db.query('UPDATE businesses SET open_days = $2 WHERE id = $1', [SEED.bluewave.id, [1, 2, 3, 4, 5, 6, 7]]);
      }
    });

    it('closes the conversation once it has booked, so a stray "yes" cannot book again', async () => {
      const t1 = await turn(customer, `routine checkup on ${freshDate()} at 10am`);
      await turn(customer, 'yes', t1.sessionId);

      const again = await say(customer, 'yes', t1.sessionId);
      const error = assertApiError(again, 409, 'SESSION_CLOSED');
      assert.match(error.message, /Start a new one/);
      assert.equal((await appointmentsFor(t1.sessionId)).length, 1);

      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t1.sessionId}`);
      assert.equal(body.messages.length, 4, 'the refused message is not stored');
    });
  });

  describe('when the conversation is not converging', () => {
    it('offers the form after four turns without a complete booking, keeping what was understood', async () => {
      const actions: string[] = [];
      let sessionId: string | undefined;
      let last!: AssistantTurnDto;
      // The first message names a service; the rest give the assistant nothing to work with.
      for (const text of ['I want whitening', 'hmm', 'not sure yet', 'let me think']) {
        last = await turn(customer, text, sessionId);
        sessionId = last.sessionId;
        actions.push(last.action);
      }

      assert.deepEqual(actions, ['collect_info', 'collect_info', 'collect_info', 'needs_form']);
      assert.match(last.message.content, /booking form/i);
      assert.equal(last.bookingDraft.serviceName, 'Teeth Whitening', 'the form is pre-filled with what was understood');
      assert.deepEqual(last.missing, ['date', 'time']);
    });

    it('offers the form once per conversation, not again on every later turn', async () => {
      let sessionId: string | undefined;
      const actions: string[] = [];
      let last!: AssistantTurnDto;
      for (const text of ['hello', 'hi again', 'anyone there', 'ok', 'still here', 'hmm', 'nope', 'what']) {
        last = await turn(customer, text, sessionId);
        sessionId = last.sessionId;
        actions.push(last.action);
      }
      assert.deepEqual(actions, [...Array(3).fill('collect_info'), 'needs_form', ...Array(4).fill('collect_info')]);
      assert.doesNotMatch(last.message.content, /booking form/i);
    });

    it('counts turns without progress, not messages: a turn that fills in a detail restarts the count', async () => {
      let sessionId: string | undefined;
      const actions: string[] = [];
      // Turn 2 names the service; only turns 3 to 5 then go nowhere.
      for (const text of ['hello', 'routine checkup', 'hmm', 'not sure', 'dunno']) {
        const t = await turn(customer, text, sessionId);
        sessionId = t.sessionId;
        actions.push(t.action);
      }
      assert.deepEqual(actions, ['collect_info', 'collect_info', 'collect_info', 'collect_info', 'needs_form']);
    });

    it('does not offer the form on a turn that offered alternative times, however many turns came before', async () => {
      const date = freshDate();
      assert.equal((await book(staff, { date, time: '10:00' })).status, 201);
      let sessionId: string | undefined;
      const turns: AssistantTurnDto[] = [];
      // Three turns still missing the time, then a taken time: the fourth turn
      // would count as stalled, but it offers times to pick from.
      for (const text of [`I need a routine checkup on ${date}`, 'hmm', 'not sure', 'at 10am']) {
        const t = await turn(customer, text, sessionId);
        sessionId = t.sessionId;
        turns.push(t);
      }
      assert.deepEqual(
        turns.map((t) => t.action),
        ['collect_info', 'collect_info', 'collect_info', 'collect_info'],
      );
      assert.deepEqual(turns.map((t) => t.missing), [['time'], ['time'], ['time'], ['time']]);
      assert.ok(turns[3]!.suggestions?.length, 'the fourth turn offered times to pick from');
      assert.doesNotMatch(turns[3]!.message.content, /booking form/i);
    });

    it('does not escalate a conversation that completed the booking, however long it took', async () => {
      let sessionId: string | undefined;
      const actions: string[] = [];
      for (const text of ['routine checkup', 'tomorrow', 'ok', '2pm']) {
        const t = await turn(customer, text, sessionId);
        sessionId = t.sessionId;
        actions.push(t.action);
      }
      assert.deepEqual(actions, ['collect_info', 'collect_info', 'collect_info', 'confirm']);
    });

    it('lets the form finish the booking even after the escalation', async () => {
      let sessionId: string | undefined;
      for (const text of ['hello', 'hmm', 'whatever', 'dunno']) {
        sessionId = (await turn(customer, text, sessionId)).sessionId;
      }
      const res = await customer.post<AssistantTurnDto>('/api/chat/draft', {
        sessionId,
        slots: { serviceName: 'Routine Checkup', date: freshDate(), time: '13:00' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.action, 'booked');
    });
  });

  describe('completing a booking from the structured form', () => {
    const draft = (client: ApiClient, body: unknown) => client.post<AssistantTurnDto>('/api/chat/draft', body);
    const newSession = async (client: ApiClient) =>
      (await client.post<{ session: ChatSessionDto }>('/api/chat/sessions')).body.session;

    it('books from complete slots and links the appointment to the conversation', async () => {
      const session = await newSession(customer);
      const date = freshDate();
      const res = await draft(customer, {
        sessionId: session.id,
        slots: { serviceName: 'Teeth Whitening', date, time: '11:00', notes: 'Prefers morning' },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.action, 'booked');
      assert.equal(res.body.engine, 'system', 'no model was involved, so the turn is not labelled as a degraded one');
      assert.equal(res.body.message.engine, 'system');
      assert.equal(res.body.sessionId, session.id);
      assert.deepEqual(res.body.missing, []);
      assert.match(res.body.message.content, /^Booked — Teeth Whitening/);
      const a = res.body.appointment!;
      assert.equal(a.source, 'chat');
      assert.equal(a.chatSessionId, session.id);
      assert.equal(a.notes, 'Prefers morning');
      assert.equal(a.startsAt, instant(date, '11:00'));
      assert.equal(a.endsAt, instant(date, '12:00'));

      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${session.id}`);
      assert.equal(body.session.status, 'completed');
      assert.equal(body.messages.at(-1)!.content, res.body.message.content);
      // A session opened straight into the form had no first message to name it.
      assert.equal(body.session.title, `Teeth Whitening — ${shortDate(date)}`);
    });

    it('records the submission as the user’s turn, so the transcript reads as what happened', async () => {
      const session = await newSession(customer);
      const date = freshDate();
      const res = await draft(customer, { sessionId: session.id, slots: { serviceName: 'Routine Checkup', date, time: '15:00' } });

      const { userMessage, message } = res.body;
      assert.equal(userMessage.role, 'user');
      assert.match(userMessage.content, /^Book Routine Checkup on .* at 3:00 PM\.$/);
      assert.ok(Number(userMessage.id) < Number(message.id));

      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${session.id}`);
      assert.deepEqual(
        body.messages.map((m) => [m.id, m.role, m.action]),
        [
          [userMessage.id, 'user', null],
          [message.id, 'assistant', 'booked'],
        ],
      );
    });

    it('refuses a second submission once the conversation has booked', async () => {
      const session = await newSession(customer);
      const slots = { serviceName: 'Routine Checkup', date: freshDate(), time: '11:00' };
      assert.equal((await draft(customer, { sessionId: session.id, slots })).status, 201);

      const again = await draft(customer, { sessionId: session.id, slots: { ...slots, time: '12:00' } });
      assertApiError(again, 409, 'SESSION_CLOSED');
      assert.equal((await appointmentsFor(session.id)).length, 1);
    });

    it('merges with what the conversation already knows', async () => {
      const t1 = await turn(customer, 'I would like whitening');
      const date = freshDate();
      const res = await draft(customer, { sessionId: t1.sessionId, slots: { date, time: '12:00' } });
      assert.equal(res.body.action, 'booked');
      assert.equal(res.body.appointment!.service.name, 'Teeth Whitening');
    });

    it('resolves a loose service name against the catalogue', async () => {
      const session = await newSession(customer);
      const res = await draft(customer, {
        sessionId: session.id,
        slots: { serviceName: 'checkup', date: freshDate(), time: '09:00' },
      });
      assert.equal(res.body.action, 'booked');
      assert.equal(res.body.appointment!.service.name, 'Routine Checkup');
    });

    it('says what is missing when the slots are incomplete, and books nothing', async () => {
      const session = await newSession(customer);
      const res = await draft(customer, {
        sessionId: session.id,
        slots: { serviceName: 'Routine Checkup', date: freshDate() },
      });
      const error = assertApiError(res, 400, 'VALIDATION_FAILED');
      assert.deepEqual(Object.keys(error.details ?? {}), ['time']);
      assert.deepEqual(await appointmentsFor(session.id), []);
    });

    it('rejects a service the business does not offer', async () => {
      const session = await newSession(customer);
      const res = await draft(customer, {
        sessionId: session.id,
        slots: { serviceName: 'Hair Transplant', date: freshDate(), time: '10:00' },
      });
      const error = assertApiError(res, 400, 'VALIDATION_FAILED');
      assert.deepEqual(Object.keys(error.details ?? {}), ['serviceName']);
    });

    it('applies the same rules as every other path: a taken slot yields alternatives', async () => {
      const date = freshDate();
      await book(staff, { date, time: '10:00' });
      const session = await newSession(customer);
      const res = await draft(customer, {
        sessionId: session.id,
        slots: { serviceName: 'Routine Checkup', date, time: '10:00' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.action, 'collect_info');
      assert.equal(res.body.appointment, undefined);
      assert.equal(res.body.suggestions!.length, 3);
      assert.equal(res.body.bookingDraft.time, null);
    });

    it('applies the same rules as every other path: opening hours and the past', async () => {
      const session = await newSession(customer);
      const outside = await draft(customer, {
        sessionId: session.id,
        slots: { serviceName: 'Routine Checkup', date: freshDate(), time: '22:00' },
      });
      assert.equal(outside.body.action, 'collect_info');
      assert.match(outside.body.message.content, /9:00 AM to 5:00 PM/);

      const past = await draft(customer, {
        sessionId: session.id,
        slots: { serviceName: 'Routine Checkup', date: pastDate(3), time: '10:00' },
      });
      assert.equal(past.body.action, 'collect_info');
      assert.deepEqual(await appointmentsFor(session.id), []);
    });

    it('validates the body', async () => {
      const session = await newSession(customer);
      assertApiError(await draft(customer, { slots: {} }), 400, 'VALIDATION_FAILED');
      assertApiError(await draft(customer, { sessionId: 'abc', slots: {} }), 400, 'VALIDATION_FAILED');
      const badTime = await draft(customer, { sessionId: session.id, slots: { time: '2pm' } });
      assert.ok(assertApiError(badTime, 400, 'VALIDATION_FAILED').details?.['slots.time']);
      const badDate = await draft(customer, { sessionId: session.id, slots: { date: '2031-02-31' } });
      assert.equal(badDate.status, 400);
    });

    it('answers 404 for a conversation that is not the caller’s', async () => {
      const session = await newSession(customer);
      const body = { sessionId: session.id, slots: { serviceName: 'Routine Checkup', date: freshDate(), time: '10:00' } };
      assertApiError(await draft(staff, body), 404, 'NOT_FOUND');
      assertApiError(await draft(northside, body), 404, 'NOT_FOUND');
      assertApiError(
        await draft(customer, { ...body, sessionId: '99999999-9999-4999-8999-999999999999' }),
        404,
        'NOT_FOUND',
      );
      assert.deepEqual(await appointmentsFor(session.id), []);
    });

    it('requires authentication', async () => {
      assertApiError(await draft(app.client(), { sessionId: SEED.bluewave.id, slots: {} }), 401, 'UNAUTHENTICATED');
    });
  });

  describe('sessions', () => {
    it('creates an empty conversation', async () => {
      const res = await customer.post<{ session: ChatSessionDto }>('/api/chat/sessions');
      assert.equal(res.status, 201);
      const { session } = res.body;
      assert.ok(isUuid(session.id));
      assert.equal(session.title, 'New conversation');
      assert.equal(session.status, 'active');
      assert.equal(session.messageCount, 0);
      assert.equal(session.lastMessageAt, null);
      assert.deepEqual(session.bookingDraft, { serviceName: null, date: null, time: null, notes: null });
    });

    it('titles a conversation after its first message, truncated for the sidebar', async () => {
      const long = `I would like to book a routine checkup ${'please '.repeat(20)}`;
      const t = await turn(customer, long);
      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t.sessionId}`);
      assert.equal(body.session.title, 'I would like to book a routine checkup please please please…');
      assert.ok(body.session.title.length <= 60);
    });

    it('titles a conversation that was created empty after the first message typed into it', async () => {
      const created = await customer.post<{ session: ChatSessionDto }>('/api/chat/sessions');
      const { id } = created.body.session;
      await turn(customer, 'Whitening before my sister’s wedding', id);
      await turn(customer, 'next week maybe', id);

      const { body } = await customer.get<{ sessions: ChatSessionDto[] }>('/api/chat/sessions');
      assert.equal(body.sessions.find((x) => x.id === id)?.title, 'Whitening before my sister’s wedding', 'the first message, not the second');
    });

    it('lists only the caller’s own conversations, most recent first', async () => {
      const mine = await turn(customer, 'a conversation of mine');
      const theirs = await turn(staff, 'a conversation of staff');
      const latest = await turn(customer, 'my latest conversation');

      const { body } = await customer.get<{ sessions: ChatSessionDto[] }>('/api/chat/sessions');
      const ids = body.sessions.map((s) => s.id);
      assert.ok(ids.includes(mine.sessionId));
      assert.ok(!ids.includes(theirs.sessionId));
      assert.ok(ids.indexOf(latest.sessionId) < ids.indexOf(mine.sessionId), 'newest activity first');

      const staffIds = (await staff.get<{ sessions: ChatSessionDto[] }>('/api/chat/sessions')).body.sessions.map((s) => s.id);
      assert.ok(staffIds.includes(theirs.sessionId));
      assert.ok(!staffIds.includes(mine.sessionId));
    });

    it('returns the transcript with the session, in order, without system messages', async () => {
      const t1 = await turn(customer, 'routine checkup please');
      await turn(customer, 'tomorrow at 3pm', t1.sessionId);
      await app.db.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'system', 'internal note')`, [
        t1.sessionId,
      ]);

      const { status, body } = await customer.get<Transcript>(`/api/chat/sessions/${t1.sessionId}`);
      assert.equal(status, 200);
      assert.equal(body.session.id, t1.sessionId);
      assert.deepEqual(
        body.messages.map((m) => [m.role, m.engine]),
        [
          ['user', null],
          ['assistant', 'fallback'],
          ['user', null],
          ['assistant', 'fallback'],
        ],
      );
      for (const m of body.messages) {
        assert.equal(typeof m.id, 'string');
        assert.ok(m.content.length > 0);
        assert.ok(!Number.isNaN(Date.parse(m.createdAt)));
      }
      assert.ok(body.messages.every((m) => m.content !== 'internal note'));
      const ids = body.messages.map((m) => Number(m.id));
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    });

    it('returns the newest 200 messages of a very long conversation, not the oldest', async () => {
      const { sessionId } = await turn(customer, 'the start of a very long conversation');
      await app.db.query(
        `INSERT INTO chat_messages (session_id, role, content)
         SELECT $1, 'user', 'filler ' || n FROM generate_series(1, 210) AS n`,
        [sessionId],
      );
      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${sessionId}`);
      assert.equal(body.messages.length, 200);
      assert.equal(body.messages.at(-1)!.content, 'filler 210', 'the latest message is present');
      // 2 real messages + 210 filler = 212; the oldest 12 are the ones dropped.
      assert.equal(body.messages[0]!.content, 'filler 11', 'the beginning is what is cut off');
      const ids = body.messages.map((m) => Number(m.id));
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'still oldest first');
    });

    it('returns the persisted user message with each turn, so a client can reconcile by id', async () => {
      const t = await turn(customer, 'routine checkup please');
      assert.equal(t.userMessage.role, 'user');
      assert.equal(t.userMessage.content, 'routine checkup please');
      assert.equal(t.userMessage.engine, null);
      assert.equal(t.userMessage.action, null);

      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t.sessionId}`);
      assert.deepEqual(
        body.messages.map((m) => m.id),
        [t.userMessage.id, t.message.id],
      );
    });

    it('restores each assistant message’s action and suggestions after a reload', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      assert.equal((await book(staff, { date, time: '10:00' })).status, 201);
      const t2 = await turn(customer, 'yes', t1.sessionId);
      assert.ok(t2.suggestions?.length);

      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t1.sessionId}`);
      const assistant = body.messages.filter((m) => m.role === 'assistant');
      assert.deepEqual(
        assistant.map((m) => m.action),
        ['confirm', 'collect_info'],
      );
      assert.equal(assistant[0]!.suggestions, undefined);
      assert.deepEqual(assistant[1]!.suggestions, t2.suggestions, 'the offered times survive a reload');
      assert.deepEqual(assistant[1], t2.message, 'the transcript and the live turn describe the message identically');

      const { rows } = await app.db.query(`SELECT meta FROM chat_messages WHERE id = $1`, [t2.message.id]);
      assert.deepEqual(rows[0].meta.missing, ['time']);
    });

    it('stores each assistant message’s own draft, so an older summary is rebuilt from what it showed', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      const t2 = await turn(customer, 'make it 11am', t1.sessionId);
      assert.equal(t2.action, 'confirm');

      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t1.sessionId}`);
      const [first, second] = body.messages.filter((m) => m.role === 'assistant');
      assert.deepEqual(first!.draft, { serviceName: 'Routine Checkup', date, time: '10:00', notes: null });
      assert.deepEqual(second!.draft, t2.bookingDraft);
      assert.equal(second!.draft!.time, '11:00');
      assert.deepEqual(second, t2.message, 'the live turn carries the same snapshot');
      assert.equal(body.messages[0]!.draft, undefined, 'user messages carry none');
      assert.deepEqual(body.appointments, [], 'nothing booked yet');
    });

    it('returns the booking a conversation made, linked from its booked message', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      const t2 = await turn(customer, 'yes', t1.sessionId);
      assert.equal(t2.action, 'booked');
      assert.equal(t2.message.appointmentId, t2.appointment!.id);

      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t1.sessionId}`);
      assert.deepEqual(body.appointments, [t2.appointment]);
      assert.equal(body.messages.at(-1)!.appointmentId, t2.appointment!.id);
      assert.deepEqual(body.messages.at(-1)!.draft, t2.bookingDraft);
    });

    it('returns a staff member’s own chat booking, and a booking from the form, whenever they fall', async () => {
      const session = (await staff.post<{ session: ChatSessionDto }>('/api/chat/sessions')).body.session;
      const date = freshDate();
      const res = await staff.post<AssistantTurnDto>('/api/chat/draft', {
        sessionId: session.id,
        slots: { serviceName: 'Teeth Whitening', date, time: '11:00' },
      });
      assert.equal(res.body.action, 'booked');

      const { body } = await staff.get<Transcript>(`/api/chat/sessions/${session.id}`);
      assert.deepEqual(body.appointments.map((a) => a.id), [res.body.appointment!.id]);
      assert.equal(body.messages.at(-1)!.appointmentId, res.body.appointment!.id);
      assert.deepEqual(body.messages.at(-1)!.draft, { serviceName: 'Teeth Whitening', date, time: '11:00', notes: null });
    });

    it('leaves out a cancelled booking, and anyone else’s row that points at the conversation', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      const t2 = await turn(customer, 'yes', t1.sessionId);
      const other = await book(staff, { date: freshDate(), time: '15:00' });
      // Finished, as a live one could not share the conversation (migration 009).
      await app.db.query(`UPDATE appointments SET chat_session_id = $1, status = 'completed' WHERE id = $2`, [
        t1.sessionId,
        other.body.appointment.id,
      ]);

      const before = await customer.get<Transcript>(`/api/chat/sessions/${t1.sessionId}`);
      assert.deepEqual(before.body.appointments.map((a) => a.id), [t2.appointment!.id], 'only the conversation owner’s row');

      assert.equal((await customer.post(`/api/appointments/${t2.appointment!.id}/cancel`, {})).status, 200);
      const after = await customer.get<Transcript>(`/api/chat/sessions/${t1.sessionId}`);
      assert.deepEqual(after.body.appointments, []);
      assert.equal(after.body.messages.at(-1)!.appointmentId, t2.appointment!.id, 'the message still says what it booked');
    });

    it('serves a message stored before drafts were recorded without one', async () => {
      const t = await turn(customer, 'routine checkup please');
      await app.db.query(`UPDATE chat_messages SET meta = meta - 'draft' WHERE id = $1`, [t.message.id]);
      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t.sessionId}`);
      const last = body.messages.at(-1)!;
      assert.equal(last.action, 'collect_info');
      assert.equal('draft' in last, false);
      assert.equal('appointmentId' in last, false);
    });

    it('restores no controls for a message stored before outcomes were recorded', async () => {
      const t = await turn(customer, 'routine checkup please');
      await app.db.query(`UPDATE chat_messages SET meta = NULL WHERE id = $1`, [t.message.id]);
      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t.sessionId}`);
      assert.equal(body.messages.at(-1)!.action, null);
    });

    it('keeps the stored draft and counters consistent with the transcript', async () => {
      const t1 = await turn(customer, 'routine checkup');
      const t2 = await turn(customer, 'tomorrow', t1.sessionId);
      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t1.sessionId}`);
      assert.deepEqual(body.session.bookingDraft, t2.bookingDraft);
      assert.equal(body.session.messageCount, body.messages.length);
      assert.equal(body.session.status, 'active');
      assert.ok(body.session.lastMessageAt);
    });

    it('answers 404 — not 403 — to any other user, in the same tenant or another', async () => {
      const t = await turn(customer, 'a private conversation about my teeth');

      for (const intruder of [staff, owner, northside]) {
        assertApiError(await intruder.get(`/api/chat/sessions/${t.sessionId}`), 404, 'NOT_FOUND');
        assertApiError(await say(intruder, 'hello?', t.sessionId), 404, 'NOT_FOUND');
      }
      // The intruder's own message must not have been written into the victim's transcript.
      const { rows } = await app.db.query('SELECT count(*)::int AS n FROM chat_messages WHERE session_id = $1', [t.sessionId]);
      assert.equal(rows[0].n, 2);
    });

    it('answers 404 for an unknown conversation and 400 for a malformed id', async () => {
      assertApiError(await customer.get('/api/chat/sessions/99999999-9999-4999-8999-999999999999'), 404, 'NOT_FOUND');
      assertApiError(await customer.get('/api/chat/sessions/not-a-uuid'), 400, 'VALIDATION_FAILED');
    });

    it('requires authentication on every endpoint', async () => {
      const anon = app.client();
      assertApiError(await anon.get('/api/chat/sessions'), 401, 'UNAUTHENTICATED');
      assertApiError(await anon.post('/api/chat/sessions'), 401, 'UNAUTHENTICATED');
      assertApiError(await anon.get(`/api/chat/sessions/${SEED.bluewave.id}`), 401, 'UNAUTHENTICATED');
      assertApiError(await say(anon, 'hello'), 401, 'UNAUTHENTICATED');
    });
  });

  describe('message validation', () => {
    it('rejects an empty, blank or missing message', async () => {
      for (const content of ['', '   ', '\n\t']) {
        const error = assertApiError(await say(customer, content), 400, 'VALIDATION_FAILED');
        assert.deepEqual(error.details?.content, ['Type a message']);
      }
      assertApiError(await customer.post('/api/chat/messages', {}), 400, 'VALIDATION_FAILED');
      assertApiError(await customer.post('/api/chat/messages', { content: 42 }), 400, 'VALIDATION_FAILED');
    });

    it('enforces the 2000-character limit exactly', async () => {
      const over = assertApiError(await say(customer, 'a'.repeat(2001)), 400, 'VALIDATION_FAILED');
      assert.deepEqual(over.details?.content, ['Message is too long']);

      const exact = await say(customer, `${'a'.repeat(1999)}b`);
      assert.equal(exact.status, 201);
    });

    it('measures the limit after trimming', async () => {
      const res = await say(customer, `   ${'a'.repeat(2000)}   `);
      assert.equal(res.status, 201);
    });

    it('rejects a malformed session id', async () => {
      const error = assertApiError(await say(customer, 'hello', 'not-a-uuid'), 400, 'VALIDATION_FAILED');
      assert.ok(error.details?.sessionId);
    });

    it('does not create a session or write anything for a rejected message', async () => {
      const before = (await app.db.query('SELECT count(*)::int AS n FROM chat_sessions')).rows[0].n;
      await say(customer, '');
      await say(customer, 'a'.repeat(5000));
      assert.equal((await app.db.query('SELECT count(*)::int AS n FROM chat_sessions')).rows[0].n, before);
    });

    it('stores a message verbatim, including characters that are special in SQL and HTML', async () => {
      const text = `Robert'); DROP TABLE appointments;-- <script>alert(1)</script> 100% "quoted" \\ back`;
      const t = await turn(customer, text);
      const { body } = await customer.get<Transcript>(`/api/chat/sessions/${t.sessionId}`);
      assert.equal(body.messages[0]!.content, text);
      const intact = await app.db.query(`SELECT to_regclass('appointments') IS NOT NULL AS present`);
      assert.equal(intact.rows[0].present, true);
    });
  });

  describe('AI interaction log', () => {
    const logsFor = (sessionId: string, expected: number) =>
      eventually(async () => {
        const { rows } = await app.db.query(
          'SELECT * FROM ai_interaction_logs WHERE session_id = $1 ORDER BY id',
          [sessionId],
        );
        return rows.length >= expected ? rows : undefined;
      });

    it('records every turn: provider, outcome, latency, request id and the slots extracted', async () => {
      const first = await say(customer, 'I need a routine checkup');
      const sessionId = first.body.sessionId;
      const second = await say(customer, `on ${freshDate()} at 10am`, sessionId);

      const rows = await logsFor(sessionId, 2);
      assert.equal(rows.length, 2);

      assert.equal(rows[0].provider, 'fallback');
      assert.equal(rows[0].outcome, 'ok');
      assert.equal(rows[0].business_id, SEED.bluewave.id);
      assert.ok(Number.isInteger(rows[0].latency_ms) && rows[0].latency_ms >= 0);
      assert.equal(rows[0].model, null);
      assert.equal(rows[0].prompt_tokens, null);
      assert.match(rows[0].error_message, /No MISTRAL_API_KEY configured/);
      assert.equal(rows[0].request_id, first.headers.get('x-request-id'), 'joins to the access log');
      assert.deepEqual(rows[0].extracted_slots, { serviceName: 'Routine Checkup' });

      assert.equal(rows[1].request_id, second.headers.get('x-request-id'));
      assert.deepEqual(Object.keys(rows[1].extracted_slots).sort(), ['date', 'time']);
      assert.equal(rows[1].extracted_slots.time, '10:00');
    });

    it('stores the raw extraction on the assistant message so a turn can be replayed', async () => {
      const t = await turn(customer, 'I need a routine checkup');
      const { rows } = await app.db.query(
        `SELECT tool_calls, engine FROM chat_messages WHERE session_id = $1 AND role = 'assistant'`,
        [t.sessionId],
      );
      assert.equal(rows[0].engine, 'fallback');
      assert.deepEqual(rows[0].tool_calls, [
        { name: 'respond_to_booking_request', arguments: { serviceName: 'Routine Checkup' }, intent: 'collecting' },
      ]);
    });

    it('writes nothing for a request that never reaches the assistant', async () => {
      const t = await turn(customer, 'hello');
      await logsFor(t.sessionId, 1);
      const { rows } = await app.db.query('SELECT count(*)::int AS n FROM ai_interaction_logs');
      const before = rows[0].n;
      await say(customer, '', t.sessionId);
      await say(staff, 'hello?', t.sessionId); // someone else's session: 404
      await new Promise((resolve) => setTimeout(resolve, 150));
      const after = (await app.db.query('SELECT count(*)::int AS n FROM ai_interaction_logs')).rows[0].n;
      assert.equal(after, before);
    });
  });
});
