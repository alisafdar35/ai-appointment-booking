import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_SLOTS, type BookingSlots, type ServiceDto } from '@appt/shared';
import { humanDate, todayInZone } from '../../src/lib/time.js';
import { applyGuardrails, isGroundedService, mentionsOtherDate, mentionsOtherTime } from '../../src/modules/ai/guardrails.js';
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

type Turn = ProviderInput['history'][number];

/** `earlier` is the conversation before `userText`, oldest first, as the model is shown it. */
function check(userText: string, model: Partial<ProviderOutput>, draft: Partial<BookingSlots> = {}, earlier: Turn[] = []) {
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
    history: [...earlier, { role: 'user', content: userText }],
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

describe('time cross-check', () => {
  it('replaces a time the model read wrongly with the one the message settles', () => {
    // "afternoon" settles PM, so "around 3" is 15:00, not the 14:00 afternoon default.
    const { output, events } = check('afternoon around 3', { slots: { time: '14:00' } });
    assert.equal(output.slots.time, '15:00');
    assert.deepEqual(events, [{ kind: 'time_corrected', model: '14:00', deterministic: '15:00' }]);
  });

  it('fills in a time the model left out', () => {
    const { output, events } = check('whitening at 3pm', { slots: { serviceName: 'Teeth Whitening' } });
    assert.equal(output.slots.time, '15:00');
    assert.deepEqual(events, [{ kind: 'time_corrected', model: null, deterministic: '15:00' }]);
  });

  it('reads 24-hour and noon as settled', () => {
    assert.equal(check('15:30 works', { slots: { time: '03:30' } }).output.slots.time, '15:30');
    assert.equal(check('at noon', { slots: { time: '00:00' } }).output.slots.time, '12:00');
  });

  it('leaves the model’s time alone when the two agree', () => {
    assert.deepEqual(check('3pm please', { slots: { time: '15:00' } }).events, []);
  });

  it('does not log a correction when the draft already holds the time the model left out', () => {
    const { output, events } = check('yes, 3pm is right', { slots: {} }, { time: '15:00' });
    assert.equal(output.slots.time, undefined, 'nothing changes, so nothing to correct');
    assert.deepEqual(events, []);
  });

  it('defers to the model when AM or PM was only a guess from opening hours', () => {
    // "around 8" is 8 AM by opening hours, but the conversation may have said "evening".
    const { output, events } = check('around 8', { slots: { time: '20:00' } });
    assert.equal(output.slots.time, '20:00');
    assert.deepEqual(events, []);
  });

  it('does not treat a part of the day with no clock time as a stated time', () => {
    const { output, events } = check('sometime in the afternoon', { slots: { time: '15:00' } });
    assert.equal(output.slots.time, '15:00');
    assert.deepEqual(events, []);
  });

  it('replaces a reply that names the time it got wrong', () => {
    const reply = '2pm it is. Which day?';
    const { output, events } = check('afternoon around 3', { reply, slots: { time: '14:00' } }, { serviceName: 'Routine Checkup' });
    assert.deepEqual(events, [
      { kind: 'time_corrected', model: '14:00', deterministic: '15:00' },
      { kind: 'reply_replaced', reason: 'time_mismatch', reply },
    ]);
    assert.match(output.reply, /3:00 PM\. Which day would you like to come in\?/);
  });
});

describe('service grounding', () => {
  it('drops a service the user never named and asks for one instead (the live "whenever" failure)', () => {
    const { output, events } = check(
      'whenever',
      { reply: 'A Routine Checkup it is — what day?', slots: { serviceName: 'Routine Checkup' } },
      {},
      [
        { role: 'user', content: 'hi, I want to book something' },
        { role: 'assistant', content: 'Which service, and when?' },
      ],
    );
    assert.equal(output.slots.serviceName, undefined);
    assert.deepEqual(events, [{ kind: 'service_ungrounded', model: 'Routine Checkup', kept: null }]);
    assert.match(output.reply, /^Which service would you like\? We offer: Routine Checkup, Teeth Whitening\.$/);
  });

  it('keeps the service already in the draft rather than the invented one', () => {
    const { output, events } = check('whenever', { slots: { serviceName: 'Routine Checkup' } }, { serviceName: 'Teeth Whitening' });
    assert.equal(output.slots.serviceName, undefined, 'nothing to merge: the draft keeps Teeth Whitening');
    assert.deepEqual(events, [{ kind: 'service_ungrounded', model: 'Routine Checkup', kept: 'Teeth Whitening' }]);
    assert.ok(!output.reply.includes('Routine Checkup'), output.reply);
  });

  it('accepts a service the user named by an alias in this message', () => {
    const { output, events } = check('I need a check up', { slots: { serviceName: 'Routine Checkup' } });
    assert.equal(output.slots.serviceName, 'Routine Checkup');
    assert.deepEqual(events, []);
  });

  it('accepts a service the user named earlier in the conversation', () => {
    const earlier: Turn[] = [
      { role: 'user', content: 'whitening please' },
      { role: 'assistant', content: 'Which day?' },
    ];
    assert.deepEqual(check('friday', { slots: { serviceName: 'Teeth Whitening' } }, {}, earlier).events, []);
  });

  it('does not count a service only the assistant mentioned', () => {
    const earlier: Turn[] = [
      { role: 'user', content: 'what do you offer?' },
      { role: 'assistant', content: 'We offer Routine Checkup and Teeth Whitening.' },
    ];
    assert.equal(check('ok, friday', { slots: { serviceName: 'Routine Checkup' } }, {}, earlier).events[0]?.kind, 'service_ungrounded');
  });

  it('accepts the service already in the draft, even abbreviated', () => {
    assert.deepEqual(check('friday', { slots: { serviceName: 'whitening' } }, { serviceName: 'Teeth Whitening' }).events, []);
  });

  it('accepts a service outside the catalogue that the user asked for, so the conversation can say it is not offered', () => {
    const { output, events } = check('the deep clean plus please', { slots: { serviceName: 'Deep Clean Plus' } });
    assert.equal(output.slots.serviceName, 'Deep Clean Plus');
    assert.deepEqual(events, []);
  });

  it('does not let an ambiguous mention ground the model’s pick of one service', () => {
    const services = ['Teeth Whitening', 'Teeth Cleaning'].map((name, i) => ({
      id: `00000000-0000-0000-0000-00000000000${i}`,
      name,
      description: null,
      durationMinutes: 30,
      priceCents: 0,
    }));
    const history: Turn[] = [{ role: 'user', content: 'something for my teeth' }];
    assert.equal(isGroundedService('Teeth Whitening', { services, history, draft: { serviceName: null } }), false);
    assert.equal(isGroundedService('Teeth', { services, history, draft: { serviceName: null } }), true, 'the user did say "teeth"');
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

describe('mentionsOtherTime', () => {
  it('accepts the same time however it is written', () => {
    for (const text of ['3pm', '3:00 PM', 'at 3 p.m.', '15:00', 'Wednesday at 3pm']) {
      assert.equal(mentionsOtherTime(text, '15:00'), false, text);
    }
  });

  it('spots a different time', () => {
    for (const text of ['2pm', '3:30 pm', '3am', '14:00']) {
      assert.equal(mentionsOtherTime(text, '15:00'), true, text);
    }
  });

  it('ignores bare numbers', () => {
    assert.equal(mentionsOtherTime('3 people, 2 days', '15:00'), false);
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
