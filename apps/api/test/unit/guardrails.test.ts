import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_SLOTS, type BookingSlots, type ServiceDto } from '@appt/shared';
import { humanDate, todayInZone } from '../../src/lib/time.js';
import { applyGuardrails, mentionsOtherDate } from '../../src/modules/ai/guardrails.js';
import type { ProviderInput, ProviderOutput } from '../../src/modules/ai/provider.js';
import { addDays, nextWeekday } from '../helpers/fixtures.js';

/**
 * The checks applied to a model answer that passed schema validation. Driven
 * with hand-built model outputs, because the point is what happens when the
 * model is confidently wrong — which a live model does only occasionally.
 */

const TIMEZONE = 'America/New_York';
const today = todayInZone(TIMEZONE);
const wednesday = nextWeekday(today, 3);

const services: ServiceDto[] = [
  { id: '00000000-0000-0000-0000-000000000001', name: 'Routine Checkup', description: null, durationMinutes: 30, priceCents: 0 },
  { id: '00000000-0000-0000-0000-000000000002', name: 'Teeth Whitening', description: null, durationMinutes: 60, priceCents: 0 },
];

function check(userText: string, model: Partial<ProviderOutput>, draft: Partial<BookingSlots> = {}) {
  const input: ProviderInput = {
    businessName: 'Bluewave Dental',
    timezone: TIMEZONE,
    opensAt: '09:00',
    closesAt: '17:00',
    today,
    nowTime: '10:00',
    services,
    draft: { ...EMPTY_SLOTS, ...draft },
    customerName: 'Marcus',
    history: [{ role: 'user', content: userText }],
    requestId: 'req-test-0001',
  };
  const output: ProviderOutput = {
    reply: 'Which time suits you?',
    slots: {},
    intent: 'collecting',
    engine: 'mistral',
    latencyMs: 5,
    ...model,
  };
  return applyGuardrails(output, input);
}

describe('date cross-check', () => {
  it('replaces a date the model resolved wrongly with the deterministic reading of the same message', () => {
    const wrong = addDays(wednesday, 1);
    const { output, events } = check('whitening on wednesday', { slots: { serviceName: 'Teeth Whitening', date: wrong } });
    assert.equal(output.slots.date, wednesday);
    assert.equal(output.slots.serviceName, 'Teeth Whitening', 'the other slots are left alone');
    assert.deepEqual(events[0], { kind: 'date_corrected', model: wrong, deterministic: wednesday });
  });

  it('leaves the model’s date alone when the two agree', () => {
    const { output, events } = check('whitening on wednesday', { slots: { date: wednesday } });
    assert.equal(output.slots.date, wednesday);
    assert.deepEqual(events, []);
  });

  it('does not add a date the model chose not to extract', () => {
    const { output, events } = check('whitening on wednesday', { slots: { serviceName: 'Teeth Whitening' } });
    assert.equal(output.slots.date, undefined);
    assert.deepEqual(events, []);
  });

  it('defers to the model when the message alone cannot fix the date', () => {
    // "the 14th" needs the month from earlier in the conversation.
    const date = addDays(today, 40);
    const { output, events } = check('the 14th please', { slots: { date } });
    assert.equal(output.slots.date, date);
    assert.deepEqual(events, []);
  });
});

describe('reply check', () => {
  const claims = [
    'Booked! See you then.',
    'Great — I’ve booked you in for a checkup.',
    'You are now confirmed for Teeth Whitening.',
    'Your appointment is scheduled.',
    "You're all set!",
  ];
  for (const reply of claims) {
    it(`replaces a reply that claims a booking exists: "${reply}"`, () => {
      const { output, events } = check('a checkup please', { reply, slots: { serviceName: 'Routine Checkup' } });
      assert.match(output.reply, /^Got it — Routine Checkup\. What day and time would suit you\?/);
      assert.deepEqual(events, [{ kind: 'reply_replaced', reason: 'booking_claim', reply }]);
    });
  }

  const harmless = [
    'Shall I book that for you?',
    'That time is already booked by someone else — would 3 PM work?',
    'What day would you like to come in?',
  ];
  for (const reply of harmless) {
    it(`keeps a reply that only talks about booking: "${reply}"`, () => {
      assert.deepEqual(check('a checkup please', { reply }).events, []);
    });
  }

  it('replaces a reply that names a different day from the draft, built from the draft instead', () => {
    const reply = `See you on ${humanDate(addDays(wednesday, 1))} — what time?`;
    const { output, events } = check('next week some time', { reply }, { serviceName: 'Routine Checkup', date: wednesday });
    assert.equal(events[0]?.kind, 'reply_replaced');
    assert.ok(output.reply.includes(humanDate(wednesday)), output.reply);
    assert.match(output.reply, /What time works for you\?/);
  });

  it('checks the reply against the corrected date, not the model’s', () => {
    const wrong = addDays(wednesday, 1);
    const reply = `${humanDate(wrong)} works — what time?`;
    const { events } = check('whitening on wednesday', { reply, slots: { serviceName: 'Teeth Whitening', date: wrong } });
    assert.deepEqual(
      events.map((e) => e.kind),
      ['date_corrected', 'reply_replaced'],
    );
  });

  it('does not judge weekdays when the draft has no date to contradict', () => {
    assert.deepEqual(check('hello', { reply: 'We are open Monday to Friday.' }).events, []);
  });
});

describe('mentionsOtherDate', () => {
  const date = '2026-10-07'; // a Wednesday

  it('accepts the same day however it is written', () => {
    for (const text of ['Wednesday 7 October', 'Wed, Oct 7th', 'on the 7th of October', '2026-10-07', 'wednesdays are quiet']) {
      assert.equal(mentionsOtherDate(text, date), false, text);
    }
  });

  it('spots a different weekday, day or month', () => {
    for (const text of ['Thursday 8 October', 'Wednesday 8 October', '7 November', 'Oct 8', 'Thurs at 3', '2026-10-08']) {
      assert.equal(mentionsOtherDate(text, date), true, text);
    }
  });

  it('ignores words that only look like dates', () => {
    for (const text of ['I sat down', 'the sun is out', '3 markets', 'you may come at 3']) {
      assert.equal(mentionsOtherDate(text, date), false, text);
    }
  });
});
