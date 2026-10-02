import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AssistantTurnDto, ChatMessageDto, ChatSessionDto } from '@appt/shared';
import { assertApiError, eventually, isUuid } from '../helpers/assertions.js';
import { book, instant } from '../helpers/booking.js';
import { SEED, addDays, freshDate, futureDate } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient, ApiResponse } from '../helpers/apiClient.js';
import { shortDate } from '../../src/lib/time.js';

type Transcript = { session: ChatSessionDto; messages: ChatMessageDto[] };

/**
 * End-to-end conversations on the deterministic engine (no MISTRAL_API_KEY),
 * which is the engine every reviewer without a key will actually meet.
 *
 * Dates are written into messages as ISO dates ("on 2031-04-22 at 10am") where
 * a test needs a specific slot: chrono resolves "next monday" against the real
 * clock, which is fine for the one test about relative dates and a source of
 * collisions everywhere else.
 */
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

    it('reports a taken slot with real alternatives, and lets the user pick one', async () => {
      const date = freshDate();
      assert.equal((await book(staff, { date, time: '10:00' })).status, 201);

      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
      assert.equal(t1.action, 'confirm');
      const t2 = await turn(customer, 'yes', t1.sessionId);

      assert.equal(t2.action, 'collect_info');
      assert.equal(t2.appointment, undefined);
      assert.match(t2.message.content, /already booked/i);
      assert.equal(t2.bookingDraft.time, null, 'the dead time is dropped so it is not proposed again');
      assert.equal(t2.bookingDraft.date, date);
      assert.equal(t2.bookingDraft.serviceName, 'Routine Checkup');
      assert.deepEqual(t2.missing, ['time']);

      const suggestions = t2.suggestions!;
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
        assert.ok(t2.message.content.includes(s.label), `the reply names ${s.label}`);
      }
      // Every suggestion really is free.
      const free = await customer.get<{ availability: { slots: { time: string; available: boolean }[] } }>(
        `/api/services/${SEED.services.routineCheckup.id}/availability?date=${date}`,
      );
      for (const s of suggestions) {
        assert.equal(free.body.availability.slots.find((slot) => slot.time === s.time)?.available, true);
      }

      // The user picks one of them and the conversation carries on.
      const t3 = await turn(customer, '9:30am', t1.sessionId);
      assert.equal(t3.action, 'confirm');
      const t4 = await turn(customer, 'yes', t1.sessionId);
      assert.equal(t4.action, 'booked');
      assert.equal(t4.appointment!.startsAt, instant(date, '09:30'));
    });

    it('refuses a time that clashes with the customer’s own booking, and offers times they are free', async () => {
      const date = freshDate();
      // The customer is in the whitening chair 10:00-11:00; the checkup itself is free at 10:30.
      assert.equal((await book(customer, { date, time: '10:00', serviceId: SEED.services.teethWhitening.id })).status, 201);

      const t1 = await turn(customer, `routine checkup on ${date} at 10:30am`);
      assert.equal(t1.action, 'confirm');
      const t2 = await turn(customer, 'yes', t1.sessionId);

      assert.equal(t2.action, 'collect_info');
      assert.match(t2.message.content, /already have an appointment at that time/i);
      assert.equal(t2.bookingDraft.time, null);
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
      const offered = t2.suggestions!.map((s) => s.time);
      assert.ok(offered.length > 0);
      for (const time of ['10:00', '10:30']) {
        assert.ok(!offered.includes(time), `${time} overlaps the customer's own booking and must not be offered`);
      }
    });

    it('refuses a time off the half-hour grid and offers the nearest ones on it', async () => {
      const date = freshDate();
      const t1 = await turn(customer, `routine checkup on ${date} at 2:10pm`);
      assert.equal(t1.bookingDraft.time, '14:10');
      const t2 = await turn(customer, 'yes', t1.sessionId);

      assert.equal(t2.action, 'collect_info');
      assert.match(t2.message.content, /on the hour or half hour/);
      assert.equal(t2.bookingDraft.time, null);
      assert.deepEqual(t2.suggestions!.slice(0, 2).map((s) => s.time), ['14:00', '14:30']);
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
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
      const t2 = await turn(customer, 'yes', t1.sessionId);
      assert.equal(t2.action, 'collect_info');
      assert.ok(t2.suggestions!.length > 0);
      assert.ok(t2.suggestions!.every((s) => s.date > date));
      assert.match(t2.suggestions![0]!.label, /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/, 'a different day is named in the label');
    });

    it('explains opening hours when the requested time is outside them', async () => {
      const t1 = await turn(customer, `routine checkup on ${freshDate()} at 8pm`);
      const t2 = await turn(customer, 'yes', t1.sessionId);
      assert.equal(t2.action, 'collect_info');
      assert.match(t2.message.content, /9:00 AM to 5:00 PM/);
      assert.equal(t2.bookingDraft.time, null);
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('does not book a time that has already passed', async () => {
      const t1 = await turn(customer, `routine checkup on ${futureDate(-2)} at 10am`);
      const t2 = await turn(customer, 'yes', t1.sessionId);
      assert.notEqual(t2.action, 'booked');
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
      for (const text of ['I need a routine checkup', `on ${date}`, 'at 10am', 'yes', 'hmm']) {
        const t = await turn(customer, text, sessionId);
        sessionId = t.sessionId;
        turns.push(t);
      }
      assert.deepEqual(
        turns.map((t) => t.action),
        ['collect_info', 'collect_info', 'confirm', 'collect_info', 'collect_info'],
      );
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
        slots: { serviceName: 'Routine Checkup', date: futureDate(-3), time: '10:00' },
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
      assert.equal((await book(staff, { date, time: '10:00' })).status, 201);
      const t1 = await turn(customer, `routine checkup on ${date} at 10am`);
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
