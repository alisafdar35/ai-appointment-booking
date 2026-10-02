import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AssistantTurnDto } from '@appt/shared';
import { humanDate, todayInZone } from '../../src/lib/time.js';
import { eventually } from '../helpers/assertions.js';
import { instant } from '../helpers/booking.js';
import { SEED, addDays, freshDate, futureDate, nextWeekday } from '../helpers/fixtures.js';
import { TOOL_NAME, failWith, startMistralStub, tool, type MistralStub } from '../helpers/mistralStub.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';
import type { ApiClient } from '../helpers/apiClient.js';

/**
 * The Mistral path, driven over real HTTP against a local stub that speaks the
 * chat-completions protocol. What is under test is the application's side of
 * the contract: the request it builds, how it reads the answer, what it does
 * when the answer is late, wrong or absent, and — the point of the exercise —
 * that nothing a model says can write a booking the rules would refuse.
 *
 * Retry policy under test (set below): 2 attempts in total (AI_MAX_RETRIES=1),
 * each cut off after 1 second (AI_TIMEOUT_MS=1000).
 */
describe('chat with the Mistral engine', () => {
  let app: TestApp;
  let stub: MistralStub;
  let customer: ApiClient;

  before(async () => {
    stub = await startMistralStub();
    app = await startTestApp({
      env: {
        MISTRAL_API_KEY: 'test-key',
        MISTRAL_BASE_URL: stub.url,
        MISTRAL_MODEL: 'mistral-test-model',
        AI_TIMEOUT_MS: '1000',
        AI_MAX_RETRIES: '1',
      },
    });
    customer = await app.loginAs('customer');
  });
  after(async () => {
    await stub.stop();
    await app.stop();
  });
  beforeEach(() => stub.reset());

  const say = (content: string, sessionId?: string, client: ApiClient = customer) =>
    client.post<AssistantTurnDto>('/api/chat/messages', { content, ...(sessionId ? { sessionId } : {}) });

  async function turn(content: string, sessionId?: string): Promise<AssistantTurnDto> {
    const res = await say(content, sessionId);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  /** AI log rows for a session, once at least `expected` have been written. */
  const logsFor = (sessionId: string, expected: number) =>
    eventually(async () => {
      const { rows } = await app.db.query(
        'SELECT * FROM ai_interaction_logs WHERE session_id = $1 ORDER BY id',
        [sessionId],
      );
      return rows.length >= expected ? rows : undefined;
    });

  const rowFor = (rows: Record<string, unknown>[], provider: string) => rows.find((r) => r.provider === provider)!;

  const appointmentsFor = async (sessionId: string) =>
    (await app.db.query('SELECT id FROM appointments WHERE chat_session_id = $1', [sessionId])).rows;

  /** A model reply that has found every detail and is asking to confirm. */
  const allSlots = (overrides: Record<string, unknown> = {}) => ({
    reply: 'Shall I book that?',
    intent: 'collecting',
    serviceName: 'Routine Checkup',
    date: freshDate(),
    time: '10:00',
    ...overrides,
  });

  describe('a well-formed answer', () => {
    it('is used: the model’s reply, slots and engine reach the user and the log', async () => {
      stub.enqueue(
        tool(
          { reply: 'Happy to help — which day suits you for a routine checkup?', intent: 'collecting', serviceName: 'Routine Checkup' },
          { prompt_tokens: 321, completion_tokens: 27 },
        ),
      );

      const t = await turn('hi, I need a checkup');

      assert.equal(t.engine, 'mistral');
      assert.equal(t.message.engine, 'mistral');
      assert.equal(t.message.content, 'Happy to help — which day suits you for a routine checkup?');
      assert.equal(t.action, 'collect_info');
      assert.deepEqual(t.bookingDraft, { serviceName: 'Routine Checkup', date: null, time: null, notes: null });
      assert.deepEqual(t.missing, ['date', 'time']);

      const rows = await logsFor(t.sessionId, 1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const all = (await app.db.query('SELECT provider, outcome FROM ai_interaction_logs WHERE session_id = $1', [t.sessionId])).rows;
      assert.deepEqual(all, [{ provider: 'mistral', outcome: 'ok' }], 'a healthy call must not also log a fallback');
      assert.equal(rows[0].model, 'mistral-test-model');
      assert.equal(rows[0].prompt_tokens, 321);
      assert.equal(rows[0].completion_tokens, 27);
      assert.ok(Number.isInteger(rows[0].latency_ms) && rows[0].latency_ms >= 0);
      assert.equal(rows[0].error_message, null);
      assert.deepEqual(rows[0].extracted_slots, { serviceName: 'Routine Checkup' });
      assert.equal(rows[0].business_id, SEED.bluewave.id);
    });

    it('sends a request that carries the guardrails: key, forced tool, live catalogue and context', async () => {
      stub.enqueue(tool({ reply: 'Which day?', intent: 'collecting' }));
      await turn('book me something');

      assert.equal(stub.requests.length, 1);
      const request = stub.requests[0]!;
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer test-key');
      assert.match(String(request.headers['content-type']), /application\/json/);

      const { body } = request;
      assert.equal(body.model, 'mistral-test-model');
      assert.equal(body.tool_choice, 'any', 'the model must answer through the tool, never in free prose');
      assert.ok(body.temperature <= 0.5, 'extraction wants a low temperature');
      assert.ok(body.max_tokens > 0);

      assert.equal(body.tools.length, 1);
      const [declared] = body.tools;
      assert.equal(declared!.type, 'function');
      assert.equal(declared!.function.name, TOOL_NAME);
      assert.deepEqual(declared!.function.parameters.properties.serviceName!.enum, [
        'Emergency Consult',
        'Orthodontic Review',
        'Routine Checkup',
        'Teeth Whitening',
      ]);

      const [system, ...rest] = body.messages;
      assert.equal(system!.role, 'system');
      assert.match(system!.content, /Bluewave Dental/);
      assert.match(system!.content, new RegExp(todayInZone(SEED.bluewave.timezone)), 'the model is told today’s date');
      assert.match(system!.content, /America\/New_York/);
      assert.match(system!.content, /9:00 AM to 5:00 PM/);
      assert.match(system!.content, /Routine Checkup \(30 min, \$80\.00\)/);
      assert.match(system!.content, /speaking with Marcus\./, 'by first name, not by the email prefix');
      assert.deepEqual(rest, [{ role: 'user', content: 'book me something' }]);
    });

    it('re-states the draft and the transcript on the next turn so the model keeps its place', async () => {
      const slots = allSlots({ time: null, date: null });
      stub.enqueue(tool({ ...slots, reply: 'Which day?' }), tool({ reply: 'And the time?', intent: 'collecting', date: freshDate() }));

      const first = await turn('routine checkup please');
      await turn('on the 14th', first.sessionId);

      const second = stub.requests[1]!.body.messages;
      assert.match(second[0]!.content, /Service: Routine Checkup/);
      assert.deepEqual(
        second.slice(1).map((m) => [m.role, m.content]),
        [
          ['user', 'routine checkup please'],
          ['assistant', 'Which day?'],
          ['user', 'on the 14th'],
        ],
      );
    });

    it('books through the whole conversation, with the rules applied by code', async () => {
      const date = freshDate();
      stub.enqueue(
        tool(allSlots({ date, time: '14:00', reply: 'Tuesday at 3pm, right?' })),
        tool({ ...allSlots({ date, time: '14:00' }), intent: 'confirming', reply: 'Booking it now.' }),
      );

      const t1 = await turn(`routine checkup on ${date} at 2pm`);
      assert.equal(t1.action, 'confirm');
      assert.match(t1.message.content, /Just to confirm: Routine Checkup on .*2:00 PM\. Shall I book it\?/);
      assert.ok(!t1.message.content.includes('3pm'), 'the confirmation is built from the slots, not from model prose');
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);

      const t2 = await turn('yes', t1.sessionId);
      assert.equal(t2.action, 'booked');
      assert.equal(t2.engine, 'mistral');
      assert.equal(t2.appointment!.startsAt, instant(date, '14:00'));
      assert.equal(t2.appointment!.source, 'chat');
      assert.equal((await appointmentsFor(t1.sessionId)).length, 1);
    });
  });

  describe('an answer that cannot be used', () => {
    const userText = () => `routine checkup on ${freshDate()} at 10am`;

    /** The user must still get a useful, correct reply, from the deterministic engine. */
    async function assertServedByFallback(sessionId: string, t: AssistantTurnDto, outcome: string, attempts: number) {
      assert.equal(t.engine, 'fallback');
      assert.equal(t.message.engine, 'fallback');
      assert.equal(t.action, 'confirm', 'the fallback understood the message and moved the booking forward');
      assert.equal(t.bookingDraft.serviceName, 'Routine Checkup');
      assert.equal(t.bookingDraft.time, '10:00');
      assert.match(t.message.content, /Shall I book it\?/);
      assert.equal(stub.requests.length, attempts, 'attempts made against the provider');

      const rows = await logsFor(sessionId, 2);
      const failed = rowFor(rows, 'mistral');
      assert.equal(failed.outcome, outcome);
      assert.ok(failed.error_message, 'the failure reason is recorded');
      assert.equal(failed.extracted_slots, null);
      const served = rowFor(rows, 'fallback');
      assert.equal(served.outcome, 'ok');
      assert.match(String(served.error_message), /after provider failure/);
      assert.deepEqual(Object.keys(served.extracted_slots as object).sort(), ['date', 'serviceName', 'time']);
    }

    const invalidOutputs: [string, string | Record<string, unknown>][] = [
      ['malformed JSON in the tool arguments', '{"reply": "Sure!", "intent": "collecting"'],
      ['tool arguments that are a JSON array', '["reply"]'],
      ['tool arguments that are a bare string', '"hello"'],
      ['a missing reply', { intent: 'collecting', serviceName: 'Routine Checkup' }],
      ['an intent the contract does not define', { reply: 'ok', intent: 'book_everything' }],
      ['a time in 12-hour form', { reply: 'ok', intent: 'collecting', time: '2pm' }],
      ['an out-of-range time', { reply: 'ok', intent: 'collecting', time: '25:00' }],
      ['a natural-language date', { reply: 'ok', intent: 'collecting', date: 'next friday' }],
      ['a date that does not exist', { reply: 'ok', intent: 'collecting', date: '2031-02-31' }],
      ['a reply longer than the contract allows', { reply: 'x'.repeat(601), intent: 'collecting' }],
    ];

    for (const [label, args] of invalidOutputs) {
      it(`falls back on ${label}, without retrying: the model answered, the answer was wrong`, async () => {
        stub.enqueue(tool(args));
        const message = userText();
        const res = await say(message);
        assert.equal(res.status, 201);
        await assertServedByFallback(res.body.sessionId, res.body, 'invalid_output', 1);
      });
    }

    it('never lets a rejected value into the stored draft', async () => {
      stub.enqueue(tool({ reply: 'ok', intent: 'collecting', serviceName: 'Routine Checkup', date: 'next friday', time: '2pm' }));
      const t = await turn('checkup, next friday, 2pm');
      // Whatever the deterministic engine understood, the model's raw values are not in it.
      assert.notEqual(t.bookingDraft.date, 'next friday');
      assert.notEqual(t.bookingDraft.time, '2pm');
    });

    it('falls back when the model answers in prose instead of calling the tool, rather than dropping what the user said', async () => {
      stub.enqueue({ kind: 'prose', content: 'Sure thing! When would you like to come in?' });
      const res = await say(userText());
      await assertServedByFallback(res.body.sessionId, res.body, 'invalid_output', 1);
      const rows = await logsFor(res.body.sessionId, 2);
      assert.match(String(rowFor(rows, 'mistral').error_message), /prose/);
    });

    it('falls back when the response has no choices', async () => {
      stub.enqueue({ kind: 'empty' });
      const res = await say(userText());
      await assertServedByFallback(res.body.sessionId, res.body, 'invalid_output', 1);
    });

    it('retries a 200 whose body is not JSON, then falls back', async () => {
      stub.enqueue({ kind: 'garbage' }, { kind: 'garbage' });
      const res = await say(userText());
      await assertServedByFallback(res.body.sessionId, res.body, 'provider_error', 2);
    });
  });

  describe('retry policy', () => {
    const userText = () => `routine checkup on ${freshDate()} at 10am`;
    const good = () => tool({ reply: 'Which day works?', intent: 'collecting', serviceName: 'Routine Checkup' });

    for (const status of [500, 502, 503, 504, 408]) {
      it(`retries once after an HTTP ${status} and uses the second answer`, async () => {
        stub.enqueue(failWith(status), good());
        const t = await turn(userText());
        assert.equal(stub.requests.length, 2);
        assert.equal(t.engine, 'mistral');
        assert.equal(t.message.content, 'Which day works?');

        const rows = await logsFor(t.sessionId, 1);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const all = (await app.db.query('SELECT provider, outcome FROM ai_interaction_logs WHERE session_id = $1', [t.sessionId])).rows;
        assert.deepEqual(all, [{ provider: 'mistral', outcome: 'ok' }], 'a recovered call is one success, not a failure plus a success');
        assert.equal(rows[0].outcome, 'ok');
      });
    }

    it('retries a rate limit (429) once, then gives up and falls back', async () => {
      stub.enqueue(failWith(429, 'slow down'), failWith(429, 'slow down'));
      const res = await say(userText());

      assert.equal(res.status, 201, 'a rate-limited provider must not surface as an error to the user');
      assert.equal(res.body.engine, 'fallback');
      assert.equal(res.body.action, 'confirm');
      assert.equal(stub.requests.length, 2, 'AI_MAX_RETRIES=1 means two attempts, not more');
      assert.equal(stub.unscripted, 0);

      const rows = await logsFor(res.body.sessionId, 2);
      const failed = rowFor(rows, 'mistral');
      assert.equal(failed.outcome, 'rate_limited');
      assert.match(String(failed.error_message), /429/);
      assert.equal(rowFor(rows, 'fallback').outcome, 'ok');
    });

    it('recovers when the rate limit clears on the retry', async () => {
      stub.enqueue(failWith(429), good());
      const t = await turn(userText());
      assert.equal(t.engine, 'mistral');
      assert.equal(stub.requests.length, 2);
    });

    it('gives up after the configured attempts on persistent server errors', async () => {
      stub.enqueue(failWith(500), failWith(500), failWith(500));
      const res = await say(userText());
      assert.equal(res.body.engine, 'fallback');
      assert.equal(stub.requests.length, 2);
      assert.equal(stub.unscripted, 0, 'no third attempt');

      const failed = rowFor(await logsFor(res.body.sessionId, 2), 'mistral');
      assert.equal(failed.outcome, 'provider_error');
      assert.match(String(failed.error_message), /500/);
    });

    for (const status of [400, 422]) {
      it(`does not retry an HTTP ${status}: the request itself is at fault, so a second try cannot help`, async () => {
        stub.enqueue(failWith(status, 'bad request'));
        const res = await say(userText());
        assert.equal(res.body.engine, 'fallback');
        assert.equal(stub.requests.length, 1);
        const failed = rowFor(await logsFor(res.body.sessionId, 2), 'mistral');
        assert.equal(failed.outcome, 'provider_error');
        assert.match(String(failed.error_message), new RegExp(String(status)));
      });
    }

    for (const status of [401, 403]) {
      it(`does not retry an HTTP ${status}, and logs it as an auth error an operator must fix`, async () => {
        stub.enqueue(failWith(status, '{"message":"Unauthorized"}'));
        const res = await say(userText());
        assert.equal(res.status, 201, 'a rejected key must not surface as an error to the user');
        assert.equal(res.body.engine, 'fallback');
        assert.equal(stub.requests.length, 1, 'the same key would be rejected again');
        const failed = rowFor(await logsFor(res.body.sessionId, 2), 'mistral');
        assert.equal(failed.outcome, 'auth_error', 'distinguishable from a transient provider failure');
        assert.match(String(failed.error_message), new RegExp(String(status)));
      });
    }

    it('waits as long as a 429 asks when that fits the time budget, instead of the usual backoff', async () => {
      stub.enqueue(failWith(429, 'slow down', { 'retry-after': '0' }), good());
      const startedAt = Date.now();
      const t = await turn(userText());
      assert.equal(t.engine, 'mistral');
      assert.equal(stub.requests.length, 2);
      // The jittered backoff alone is at least 300ms.
      assert.ok(Date.now() - startedAt < 300, `Retry-After: 0 is honoured, took ${Date.now() - startedAt}ms`);
    });

    it('falls back at once when a 429 asks for a wait longer than the time budget allows', async () => {
      stub.enqueue(failWith(429, 'slow down', { 'retry-after': '30' }), good());
      const startedAt = Date.now();
      const res = await say(userText());

      assert.equal(res.body.engine, 'fallback');
      assert.equal(stub.requests.length, 1, 'no retry the provider has said will fail');
      assert.ok(Date.now() - startedAt < 1000, 'the user is not kept waiting for the provider');
      const failed = rowFor(await logsFor(res.body.sessionId, 2), 'mistral');
      assert.equal(failed.outcome, 'rate_limited');
      assert.match(String(failed.error_message), /429 and asked for 30s/);
    });

    it('reads Retry-After given as an HTTP date', async () => {
      const inAMinute = new Date(Date.now() + 60_000).toUTCString();
      stub.enqueue(failWith(429, 'slow down', { 'retry-after': inAMinute }), good());
      const res = await say(userText());
      assert.equal(res.body.engine, 'fallback');
      assert.equal(stub.requests.length, 1);
    });

    it('cuts off a response that never arrives, retries once, then falls back with a timeout outcome', async () => {
      stub.enqueue({ kind: 'stall' }, { kind: 'stall' });
      const startedAt = Date.now();
      const res = await say(userText());
      const elapsed = Date.now() - startedAt;

      assert.equal(res.status, 201);
      assert.equal(res.body.engine, 'fallback');
      assert.equal(res.body.action, 'confirm');
      assert.equal(stub.requests.length, 2);
      assert.ok(elapsed >= 2000, `two 1s timeouts must elapse, took ${elapsed}ms`);
      assert.ok(elapsed < 6000, `the wait must stay bounded, took ${elapsed}ms`);

      const failed = rowFor(await logsFor(res.body.sessionId, 2), 'mistral');
      assert.equal(failed.outcome, 'timeout');
      assert.match(String(failed.error_message), /within 1000ms/);
    });

    it('recovers when only the first attempt stalls', async () => {
      stub.enqueue({ kind: 'stall' }, good());
      const t = await turn(userText());
      assert.equal(t.engine, 'mistral');
      assert.equal(stub.requests.length, 2);
    });
  });

  describe('a model that hallucinates', () => {
    const catalogue = /Emergency Consult, Orthodontic Review, Routine Checkup, Teeth Whitening/;

    it('cannot sell a service the business does not offer', async () => {
      const date = freshDate();
      stub.enqueue(
        tool({ reply: 'Booked your Deep Clean Plus!', intent: 'confirming', serviceName: 'Deep Clean Plus', date, time: '10:00' }),
      );
      const t = await turn('I would like the deep clean plus');

      assert.equal(t.action, 'collect_info');
      assert.equal(t.appointment, undefined);
      assert.equal(t.bookingDraft.serviceName, null);
      assert.match(t.message.content, /We don't offer that/);
      assert.match(t.message.content, catalogue, 'the reply lists what is on offer');
      assert.ok(!t.message.content.includes('Booked'), 'the model’s claim of a booking must not reach the user');
      assert.deepEqual(await appointmentsFor(t.sessionId), []);
    });

    it('cannot match every service with a SQL wildcard', async () => {
      for (const wildcard of ['%', '_', 'Routine%', '%ing%']) {
        stub.enqueue(tool({ reply: 'ok', intent: 'collecting', serviceName: wildcard, date: freshDate(), time: '10:00' }));
        // Named by the user, so the name gets past grounding and reaches the SQL match.
        const t = await turn(`I'd like ${wildcard}`);
        assert.equal(t.bookingDraft.serviceName, null, `"${wildcard}" must not resolve to a service`);
        assert.match(t.message.content, /We don't offer that/);
      }
    });

    it('cannot reach another business’s catalogue', async () => {
      stub.enqueue(tool({ reply: 'ok', intent: 'collecting', serviceName: 'General Practice', date: freshDate(), time: '10:00' }));
      const t = await turn('a general practice appointment please');
      assert.equal(t.bookingDraft.serviceName, null);
      assert.match(t.message.content, /We don't offer that/);
    });

    it('is asked to choose when its service name fits several services', async () => {
      await app.db.query(
        `INSERT INTO services (business_id, name, duration_minutes) VALUES ($1, 'Teeth Cleaning', 30)
         ON CONFLICT DO NOTHING`,
        [SEED.bluewave.id],
      );
      try {
        stub.enqueue(tool({ reply: 'ok', intent: 'collecting', serviceName: 'Teeth' }));
        const t = await turn('something for my teeth');
        assert.equal(t.action, 'collect_info');
        assert.equal(t.bookingDraft.serviceName, null, 'guessing is not allowed');
        assert.match(t.message.content, /Did you mean Teeth Cleaning or Teeth Whitening\?/);
      } finally {
        await app.db.query(`DELETE FROM services WHERE business_id = $1 AND name = 'Teeth Cleaning'`, [SEED.bluewave.id]);
      }
    });

    it('stores the catalogue’s name when the model abbreviates it', async () => {
      stub.enqueue(tool({ reply: 'ok', intent: 'collecting', serviceName: 'whitening' }));
      const t = await turn('whitening please');
      assert.equal(t.bookingDraft.serviceName, 'Teeth Whitening');
    });

    it('cannot book on the user’s behalf by declaring the user confirmed, before any summary was shown', async () => {
      stub.enqueue(tool(allSlots({ intent: 'confirming', reply: 'Booked!' })));
      const t = await turn('routine checkup tomorrow at 10');

      assert.equal(t.action, 'confirm');
      assert.equal(t.appointment, undefined);
      assert.deepEqual(await appointmentsFor(t.sessionId), []);
      assert.ok(!t.message.content.includes('Booked!'));
    });

    it('cannot book a different time from the one the user confirmed', async () => {
      const date = freshDate();
      stub.enqueue(
        tool(allSlots({ date, time: '10:00' })),
        tool(allSlots({ date, time: '16:00', intent: 'confirming' })),
      );
      const t1 = await turn(`routine checkup on ${date} at 10am`);
      const t2 = await turn('yes', t1.sessionId);

      assert.equal(t2.action, 'confirm', 'the slots changed under the user, so the summary is shown again');
      assert.equal(t2.bookingDraft.time, '16:00');
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('cannot book a date that has already passed', async () => {
      const past = futureDate(-30);
      stub.enqueue(tool(allSlots({ date: past })), tool(allSlots({ date: past, intent: 'confirming' })));

      const t1 = await turn('routine checkup please');
      const t2 = await turn('yes', t1.sessionId);

      assert.equal(t2.action, 'collect_info');
      assert.equal(t2.appointment, undefined);
      assert.match(t2.message.content, /already passed/i);
      assert.equal(t2.bookingDraft.date, null, 'the stale date is dropped so the next answer is not rejected too');
      assert.equal(t2.bookingDraft.time, null);
      assert.deepEqual(t2.missing, ['date', 'time']);
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('cannot book outside opening hours', async () => {
      const date = freshDate();
      stub.enqueue(tool(allSlots({ date, time: '03:00' })), tool(allSlots({ date, time: '03:00', intent: 'confirming' })));
      const t1 = await turn(`routine checkup on ${date} at 3am`);
      const t2 = await turn('yes', t1.sessionId);

      assert.equal(t2.action, 'collect_info');
      assert.match(t2.message.content, /9:00 AM to 5:00 PM/);
      assert.equal(t2.bookingDraft.time, null);
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('cannot double-book a slot that is already taken', async () => {
      const date = freshDate();
      await customer.post('/api/appointments', { serviceId: SEED.services.routineCheckup.id, date, time: '10:00' });
      stub.enqueue(tool(allSlots({ date, time: '10:00' })), tool(allSlots({ date, time: '10:00', intent: 'confirming' })));

      const t1 = await turn(`routine checkup on ${date} at 10am`);
      const t2 = await turn('yes', t1.sessionId);

      assert.equal(t2.action, 'collect_info');
      assert.equal(t2.suggestions!.length, 3);
      assert.deepEqual(await appointmentsFor(t1.sessionId), []);
    });

    it('cannot smuggle extra fields through: only the booking slots reach the draft', async () => {
      stub.enqueue(
        tool({
          reply: 'ok',
          intent: 'collecting',
          serviceName: 'Routine Checkup',
          businessId: SEED.northside.id,
          userId: SEED.users.owner.id,
          status: 'confirmed',
        }),
      );
      const t = await turn('checkup');
      assert.deepEqual(Object.keys(t.bookingDraft).sort(), ['date', 'notes', 'serviceName', 'time']);
    });
  });

  describe('a model whose answer parses but is wrong', () => {
    const wednesday = () => nextWeekday(todayInZone(SEED.bluewave.timezone), 3);

    it('is overruled on calendar arithmetic, and its wording about the wrong day is not shown', async () => {
      // The live failure: "next Wednesday" resolved to the Thursday after it.
      const right = wednesday();
      const wrong = addDays(right, 1);
      const wrongReply = `Teeth Whitening on ${humanDate(wrong)} works — what time suits you?`;
      stub.enqueue(tool({ reply: wrongReply, intent: 'collecting', serviceName: 'Teeth Whitening', date: wrong }));

      const t = await turn('teeth whitening on wednesday please');

      assert.equal(t.bookingDraft.date, right, 'the deterministic reading of the same message wins');
      assert.equal(t.action, 'collect_info');
      assert.equal(t.engine, 'mistral', 'still the model’s turn — corrected, not replaced by the fallback');
      assert.match(t.message.content, new RegExp(`${humanDate(right)}.*What time works for you\\?`));
      assert.ok(!t.message.content.includes(humanDate(wrong)));

      const [row] = await logsFor(t.sessionId, 1);
      assert.equal(row.outcome, 'ok');
      assert.equal(row.extracted_slots.date, right, 'the log shows what the draft received');
      assert.deepEqual(row.guardrails, [
        { kind: 'date_corrected', model: wrong, deterministic: right },
        { kind: 'reply_replaced', reason: 'date_mismatch', reply: wrongReply },
      ]);
    });

    it('does not show a reply that claims a booking exists while details are still missing', async () => {
      stub.enqueue(tool({ reply: 'Great news — you’re all booked in!', intent: 'collecting', serviceName: 'Routine Checkup' }));
      const t = await turn('a checkup please');

      assert.equal(t.action, 'collect_info');
      assert.ok(!/booked/i.test(t.message.content), t.message.content);
      assert.match(t.message.content, /What day and time would suit you\?/);
      const [row] = await logsFor(t.sessionId, 1);
      assert.deepEqual(row.guardrails, [
        { kind: 'reply_replaced', reason: 'booking_claim', reply: 'Great news — you’re all booked in!' },
      ]);
    });

    it('keeps the model’s own wording when it agrees with the draft', async () => {
      const date = wednesday();
      const reply = `${humanDate(date).split(',')[0]} works nicely. What time would you like?`;
      stub.enqueue(tool({ reply, intent: 'collecting', serviceName: 'Teeth Whitening', date }));
      const t = await turn('whitening on wednesday');

      assert.equal(t.message.content, reply);
      const [row] = await logsFor(t.sessionId, 1);
      assert.equal(row.guardrails, null);
    });

    it('is not overruled on a date only the conversation can pin down, such as "the 14th"', async () => {
      const date = freshDate();
      stub.enqueue(tool({ reply: 'And what time?', intent: 'collecting', serviceName: 'Routine Checkup', date }));
      const t = await turn('a checkup on the 14th');
      assert.equal(t.bookingDraft.date, date);
    });
  });

  describe('a model that reads a stated time wrongly', () => {
    it('is overruled by the time the message settles, and the log says so', async () => {
      const date = freshDate();
      stub.enqueue(tool({ reply: 'And which day?', intent: 'collecting', serviceName: 'Routine Checkup', time: '14:00' }));
      const t1 = await turn('routine checkup please, afternoon around 3');

      assert.equal(t1.bookingDraft.time, '15:00');
      assert.equal(t1.engine, 'mistral');
      const [row] = await logsFor(t1.sessionId, 1);
      assert.equal(row.extracted_slots.time, '15:00', 'the log shows what the draft received');
      assert.deepEqual(row.guardrails, [{ kind: 'time_corrected', model: '14:00', deterministic: '15:00' }]);

      // A later turn that leaves the time out keeps the corrected one.
      stub.enqueue(tool({ reply: 'Shall I book it?', intent: 'collecting', date }));
      const t2 = await turn(`${date} then`, t1.sessionId);
      assert.equal(t2.action, 'confirm');
      assert.match(t2.message.content, /at 3:00 PM\. Shall I book it\?/);
    });

    it('has a time it dropped filled in from the message', async () => {
      stub.enqueue(tool({ reply: 'Which day?', intent: 'collecting', serviceName: 'Teeth Whitening' }));
      const t = await turn('teeth whitening at 4:30pm');
      assert.equal(t.bookingDraft.time, '16:30');
      const [row] = await logsFor(t.sessionId, 1);
      assert.deepEqual(row.guardrails, [{ kind: 'time_corrected', model: null, deterministic: '16:30' }]);
    });

    it('is not overruled when AM or PM was only a guess', async () => {
      stub.enqueue(tool({ reply: 'Which day?', intent: 'collecting', serviceName: 'Routine Checkup', time: '20:00' }));
      const t = await turn('routine checkup around 8');
      assert.equal(t.bookingDraft.time, '20:00');
      const [row] = await logsFor(t.sessionId, 1);
      assert.equal(row.guardrails, null);
    });
  });

  describe('a model that invents a service', () => {
    it('cannot choose a service the user never named: the draft keeps none and the reply asks', async () => {
      // The live failure: answering "whenever" with serviceName "Routine Checkup".
      stub.enqueue(tool({ reply: 'What would you like to book, and when?', intent: 'collecting' }));
      const t1 = await turn('hi, can I book an appointment');
      stub.enqueue(
        tool({ reply: 'Great, a Routine Checkup — which day?', intent: 'collecting', serviceName: 'Routine Checkup' }),
      );
      const t2 = await turn('whenever', t1.sessionId);

      assert.equal(t2.bookingDraft.serviceName, null);
      assert.equal(t2.action, 'collect_info');
      assert.deepEqual(t2.missing, ['serviceName', 'date', 'time']);
      assert.match(t2.message.content, /^Which service would you like\? We offer: /);
      assert.ok(!t2.message.content.includes('Great, a Routine Checkup'));
      const rows = await logsFor(t1.sessionId, 2);
      assert.deepEqual(rows[1].guardrails, [{ kind: 'service_ungrounded', model: 'Routine Checkup', kept: null }]);
      assert.equal(rows[1].extracted_slots.serviceName, undefined);
    });

    it('keeps the service the user chose when the model swaps in another', async () => {
      stub.enqueue(tool({ reply: 'Which day?', intent: 'collecting', serviceName: 'Teeth Whitening' }));
      const t1 = await turn('whitening please');
      stub.enqueue(tool({ reply: 'Routine Checkup, then — what time?', intent: 'collecting', serviceName: 'Routine Checkup' }));
      const t2 = await turn('any day is fine', t1.sessionId);

      assert.equal(t2.bookingDraft.serviceName, 'Teeth Whitening');
      assert.ok(!t2.message.content.includes('Routine Checkup'), t2.message.content);
    });

    it('accepts a service the user named in an earlier message', async () => {
      stub.enqueue(tool({ reply: 'Which day?', intent: 'collecting' }));
      const t1 = await turn('I need a check up');
      stub.enqueue(tool({ reply: 'And what time?', intent: 'collecting', serviceName: 'Routine Checkup', date: freshDate() }));
      const t2 = await turn('the 14th', t1.sessionId);

      assert.equal(t2.bookingDraft.serviceName, 'Routine Checkup');
      assert.equal(t2.message.content, 'And what time?');
    });
  });

  describe('health reporting', () => {
    it('reports Mistral as the configured engine, and the owner sees its calls in the usage summary', async () => {
      const health = await app.client().get<{ aiProvider: string }>('/api/health');
      assert.equal(health.body.aiProvider, 'mistral');

      stub.enqueue(tool({ reply: 'Which day?', intent: 'collecting' }));
      await turn('hello');
      const owner = await app.loginAs('owner');
      await eventually(async () => {
        const res = await owner.get<{ summary: { byProvider: Record<string, { calls: number }> } }>('/api/ai/summary');
        // The seed holds three Mistral calls for this tenant; the turn above adds one.
        return (res.body.summary.byProvider.mistral?.calls ?? 0) > 3 ? res.body : undefined;
      });
    });
  });

  describe('when the provider is unreachable', () => {
    it('still serves every message from the fallback — this must run last, it stops the stub', async () => {
      await stub.stop();
      const res = await say(`routine checkup on ${freshDate()} at 10am`);

      assert.equal(res.status, 201);
      assert.equal(res.body.engine, 'fallback');
      assert.equal(res.body.action, 'confirm');
      const failed = rowFor(await logsFor(res.body.sessionId, 2), 'mistral');
      assert.equal(failed.outcome, 'provider_error');
      assert.match(String(failed.error_message), /Network error/);
    });
  });
});
