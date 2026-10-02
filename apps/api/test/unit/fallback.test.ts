import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_SLOTS, type BookingSlots, type ServiceDto } from '@appt/shared';
import { referenceToday } from '../helpers/clock.js';
import { CONSENT_TABLE } from '../helpers/consent.js';
import { addDays, nextWeekday } from '../helpers/fixtures.js';
import { FallbackProvider, answerAboutService, isAffirmative, matchBareHour, matchOrdinalDay, matchService, resolveMeridiem } from '../../src/modules/ai/fallback.js';
import type { ProviderInput } from '../../src/modules/ai/provider.js';

/**
 * The deterministic extractor is what serves every chat turn when the LLM is
 * unavailable, so its behaviour on the phrases people actually type is a
 * product guarantee, not an implementation detail.
 *
 * Relative dates resolve against the input's `today`, pinned by TEST_TODAY
 * (see helpers/clock.ts), so expectations are computed from it.
 */

const TIMEZONE = 'America/New_York';
const today = referenceToday(TIMEZONE);
const weekdayName = (date: string) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const isoWeekday = (date: string) => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

const catalogue: ServiceDto[] = [
  ['Routine Checkup', 30],
  ['Teeth Whitening', 60],
  ['Emergency Consult', 20],
  ['Orthodontic Review', 45],
].map(([name, durationMinutes], i) => ({
  id: `00000000-0000-0000-0000-00000000000${i + 1}`,
  name: name as string,
  description: null,
  durationMinutes: durationMinutes as number,
  priceCents: name === 'Teeth Whitening' ? 19900 : 0,
}));

const provider = new FallbackProvider();

function turn(text: string, draft: Partial<BookingSlots> = {}, overrides: Partial<ProviderInput> = {}) {
  const input: ProviderInput = {
    businessName: 'Bluewave Dental',
    timezone: TIMEZONE,
    opensAt: '09:00',
    closesAt: '17:00',
    openDays: [1, 2, 3, 4, 5, 6, 7],
    today,
    nowTime: '10:00',
    services: catalogue,
    draft: { ...EMPTY_SLOTS, ...draft },
    customerName: 'Marcus',
    history: [{ role: 'user', content: text }],
    requestId: 'req-test-0001',
    ...overrides,
  };
  return provider.respond(input);
}

describe('fallback date extraction', () => {
  it('resolves "tomorrow" against the business calendar', async () => {
    const { slots } = await turn('tomorrow');
    assert.deepEqual(slots, { date: addDays(today, 1) });
  });

  it('resolves "next friday" to a Friday in the future', async () => {
    const { slots } = await turn('can I come in next friday');
    assert.ok(slots.date);
    assert.equal(new Date(`${slots.date}T12:00:00Z`).getUTCDay(), 5);
    assert.ok(slots.date > today, 'next friday must be after today');
    assert.ok(slots.date <= addDays(today, 14));
  });

  it('resolves a weekday name to that weekday', async () => {
    // Not today's weekday: that one is ambiguous (see below).
    const day = (new Date(`${today}T12:00:00Z`).getUTCDay() + 2) % 7;
    const name = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][day]!;
    const { slots } = await turn(name);
    assert.equal(slots.date, nextWeekday(today, day));
  });

  it('reads an explicit month and day', async () => {
    const { slots } = await turn('Oct 15 at 11:30');
    assert.match(slots.date ?? '', /^\d{4}-10-15$/);
    assert.equal(slots.time, '11:30');
  });

  it('reads an ISO date', async () => {
    const { slots } = await turn('on 2031-04-22 at 10am');
    assert.deepEqual(slots, { date: '2031-04-22', time: '10:00' });
  });

  it('reads a bare ordinal day, "the 12th", as the next such day', async () => {
    const { slots } = await turn('how about the 12th');
    assert.ok(slots.date);
    assert.match(slots.date, /^\d{4}-\d{2}-12$/);
    assert.ok(slots.date >= today);
    assert.equal(slots.time, undefined);
  });

  it('keeps a stated time alongside an ordinal day', async () => {
    const { slots } = await turn('the 12th at 3pm');
    assert.match(slots.date ?? '', /-12$/);
    assert.equal(slots.time, '15:00');
  });

  it('leaves a vague range unresolved so the next turn asks for a day', async () => {
    for (const text of ['sometime next week', 'next week', 'whenever', 'soon']) {
      const { slots } = await turn(text);
      assert.equal(slots.date, undefined, `"${text}" must not be pinned to a day`);
    }
  });

  it('does not invent a date when only a time is given', async () => {
    // chrono fills in today's date for a bare "2pm"; that is implied, not stated.
    const { slots } = await turn('2pm');
    assert.deepEqual(slots, { time: '14:00' });
  });
});

describe('matchOrdinalDay', () => {
  it('uses this month when the day has not passed yet', () => {
    assert.equal(matchOrdinalDay('the 12th', '2026-10-02'), '2026-10-12');
    assert.equal(matchOrdinalDay('the 2nd', '2026-10-02'), '2026-10-02');
  });

  it('rolls to next month when the day has passed', () => {
    assert.equal(matchOrdinalDay('the 1st', '2026-10-02'), '2026-11-01');
  });

  it('rolls over the year boundary', () => {
    assert.equal(matchOrdinalDay('the 3rd', '2026-12-20'), '2027-01-03');
  });

  it('skips months that do not have the requested day', () => {
    // 31 September does not exist; the next 31st after 2026-09-15 is in October.
    assert.equal(matchOrdinalDay('the 31st', '2026-09-15'), '2026-10-31');
    // And February has neither a 30th nor a 31st.
    assert.equal(matchOrdinalDay('the 30th', '2027-01-31'), '2027-03-30');
  });

  it('ignores text without an ordinal and out-of-range days', () => {
    assert.equal(matchOrdinalDay('tomorrow', '2026-10-02'), null);
    assert.equal(matchOrdinalDay('the 40th', '2026-10-02'), null);
    assert.equal(matchOrdinalDay('the 0th', '2026-10-02'), null);
  });
});

describe('fallback time extraction', () => {
  it('reads 12-hour times', async () => {
    assert.equal((await turn('3pm')).slots.time, '15:00');
    assert.equal((await turn('at 9am')).slots.time, '09:00');
    assert.equal((await turn('2:30 pm')).slots.time, '14:30');
    assert.equal((await turn('noon')).slots.time, '12:00');
  });

  it('reads 24-hour times', async () => {
    assert.equal((await turn('15:30')).slots.time, '15:30');
    assert.equal((await turn('at 08:15')).slots.time, '08:15');
  });

  it('combines a date and a time from one sentence', async () => {
    const { slots } = await turn('tomorrow at 2pm');
    assert.deepEqual(slots, { date: addDays(today, 1), time: '14:00' });
  });

  it('turns a part of the day into a sensible time inside opening hours', async () => {
    assert.equal((await turn('in the morning')).slots.time, '09:00');
    assert.equal((await turn('sometime this afternoon')).slots.time, '14:00');
    // Evening is clamped to an hour before closing: 17:00 close -> 16:00.
    assert.equal((await turn('evening works')).slots.time, '16:00');
  });

  it('prefers an explicit clock time over a part of the day', async () => {
    assert.equal((await turn('tomorrow morning at 11am')).slots.time, '11:00');
  });
});

describe('fallback times said without am or pm', () => {
  const timeOf = async (text: string) => (await turn(text)).slots.time;

  it('reads "afternoon around 3" as 3 PM, not as the afternoon default', async () => {
    assert.equal(await timeOf('afternoon around 3'), '15:00');
    assert.equal(await timeOf('can I come in the afternoon, about 3:30?'), '15:30');
  });

  it('places a bare hour when only one reading is inside opening hours: 3 is 3 PM for a 9–5 business', async () => {
    assert.equal(await timeOf('at 3'), '15:00');
    assert.equal(await timeOf('around 4'), '16:00');
    assert.equal(await timeOf('3ish works'), '15:00');
    assert.equal(await timeOf('tomorrow at 1:30'), '13:30');
  });

  it('keeps a bare hour that is already inside opening hours as said', async () => {
    assert.equal(await timeOf('at 10'), '10:00');
    assert.equal(await timeOf('around 11'), '11:00');
  });

  it('lets "morning" keep an hour in the morning, and "evening" move it to the evening', async () => {
    assert.equal(await timeOf('tomorrow morning at 8'), '08:00');
    assert.equal(await timeOf('around 9 in the morning'), '09:00');
    assert.equal(await timeOf('in the evening around 5'), '17:00');
  });

  it('reads a leading zero as 24-hour notation', async () => {
    assert.equal(await timeOf('at 08:15'), '08:15');
  });

  it('does not read a count of something as a time', async () => {
    assert.equal(matchBareHour('for about 3 weeks'), null);
    assert.equal(matchBareHour('at 2 people'), null);
    assert.equal(matchBareHour('around 3pm'), null, 'an explicit meridiem is chrono’s to read');
    assert.equal(await timeOf('my tooth has hurt for about 3 days'), undefined);
  });
});

describe('resolveMeridiem', () => {
  const nineToFive = { opensAt: '09:00', closesAt: '17:00' };
  const earlyShift = { opensAt: '06:00', closesAt: '14:00' };
  const longDay = { opensAt: '08:00', closesAt: '22:00' };

  it('takes the reading that falls inside opening hours when only one does', () => {
    assert.equal(resolveMeridiem(7, 0, 'at 7', earlyShift), 7, '7 AM is open, 7 PM is not');
    assert.equal(resolveMeridiem(1, 0, 'at 1', earlyShift), 13);
    assert.equal(resolveMeridiem(10, 0, 'at 10', nineToFive), 10);
  });

  it('declines to choose when neither reading can start an appointment', () => {
    assert.equal(resolveMeridiem(5, 0, 'at 5', nineToFive), null, '5 AM is before opening, 5 PM is closing time');
    assert.equal(resolveMeridiem(6, 0, 'at 6', nineToFive), null);
    assert.equal(resolveMeridiem(8, 0, 'at 8', nineToFive), null);
  });

  it('declines to choose when both readings are inside opening hours', () => {
    assert.equal(resolveMeridiem(9, 0, 'at 9', longDay), null);
    assert.equal(resolveMeridiem(9, 0, 'at 9 in the morning', longDay), 9, 'a stated part of the day still decides');
  });

  it('leaves 12 and 24-hour values alone', () => {
    assert.equal(resolveMeridiem(12, 0, 'at 12', nineToFive), 12);
    assert.equal(resolveMeridiem(15, 0, 'at 15', nineToFive), 15);
    assert.equal(resolveMeridiem(0, 30, 'at 0:30', nineToFive), 0);
  });
});

describe('fallback clarifications: ask rather than guess', () => {
  const complete: Partial<BookingSlots> = { serviceName: 'Routine Checkup', date: '2031-04-22', time: '10:00' };

  it('asks AM or PM for "At 5.", and stores no time', async () => {
    const out = await turn('At 5.', { serviceName: 'Routine Checkup', date: '2031-04-22' });
    assert.equal(out.slots.time, undefined);
    assert.deepEqual(out.clarify, ['time']);
    assert.match(out.reply, /Did you mean 5:00 AM or 5:00 PM\? We're open 9:00 AM to 5:00 PM/);
  });

  it('reopens a confirmed time the user is changing ambiguously, so "yes" cannot book the old one', async () => {
    const out = await turn('actually at 8', complete);
    assert.deepEqual(out.clarify, ['time']);
    assert.equal(out.intent, 'collecting');
    assert.ok(!/Shall I book it/.test(out.reply), out.reply);
  });

  it('asks which date "03/04" means, and stores no date', async () => {
    const out = await turn('Book for 03/04.', { serviceName: 'Routine Checkup' });
    assert.equal(out.slots.date, undefined);
    assert.deepEqual(out.clarify, ['date']);
    assert.match(out.reply, /Did you mean \w+, March 4, \d{4} or \w+, April 3, \d{4}\?/);
  });

  it('does not ask about a numeric date that reads one way only', async () => {
    for (const text of ['13/04', '04/04', 'on 2031-04-22']) {
      const out = await turn(text);
      assert.equal(out.clarify, undefined, text);
      assert.ok(out.slots.date, text);
    }
  });

  it('asks whether today’s weekday means today or next week while today is still bookable', async () => {
    const name = weekdayName(today);
    const out = await turn(`Book me on ${name}.`);
    assert.deepEqual(out.clarify, ['date']);
    assert.equal(out.slots.date, undefined);
    assert.match(out.reply, new RegExp(`Did you mean ${name}, .* or ${name}, .*\\?`));

    assert.equal((await turn(`next ${name}`)).clarify, undefined, '"next" settles it');
  });

  describe('today’s weekday when today cannot be booked: a week today, without asking', () => {
    const name = weekdayName(today);
    const weekToday = addDays(today, 7);
    const resolvesToNextWeek = async (text: string, overrides: Partial<ProviderInput>, why: string) => {
      const out = await turn(text, {}, overrides);
      assert.equal(out.clarify, undefined, why);
      assert.equal(out.slots.date, weekToday, why);
    };

    it('after closing time', async () => {
      await resolvesToNextWeek(`Book me on ${name}.`, { nowTime: '17:30' }, 'closed for the day');
    });

    it('when no appointment slot is left before closing', async () => {
      // The next slot on the 30-minute grid after 16:40 is 17:00, closing time.
      await resolvesToNextWeek(`Book me on ${name}.`, { nowTime: '16:40' }, 'no slot left today');
    });

    it('when the time asked for has already passed today', async () => {
      await resolvesToNextWeek(`${name} at 9am`, { nowTime: '11:00' }, '9 AM today is gone');
      const later = await turn(`${name} at 3pm`, {}, { nowTime: '11:00' });
      assert.deepEqual(later.clarify, ['date'], '3 PM today is still ahead, so both readings stand');
    });

    it('when the business does not open on that weekday at all', async () => {
      const closed = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== isoWeekday(today));
      await resolvesToNextWeek(`Book me on ${name}.`, { openDays: closed }, 'neither reading is bookable');
    });

    it('keeps the service and time stated alongside it', async () => {
      const out = await turn(`checkup on ${name} at 2pm`, {}, { nowTime: '17:30' });
      assert.deepEqual(out.slots, { serviceName: 'Routine Checkup', date: weekToday, time: '14:00' });
    });
  });

  it('asks for the service, day and time together when nothing is known', async () => {
    const out = await turn('I want an appointment.');
    assert.match(out.reply, /Which service would you like, and what day and time suit you\?/);
    assert.match(out.reply, /Routine Checkup/);
    assert.match(out.reply, /9:00 AM to 5:00 PM/);
  });

  it('names the open days when asking for a day, if the business is closed on some', async () => {
    const out = await provider.respond({
      businessName: 'Bluewave Dental',
      timezone: TIMEZONE,
      opensAt: '09:00',
      closesAt: '17:00',
      openDays: [1, 2, 3, 4, 5],
      today,
      nowTime: '10:00',
      services: catalogue,
      draft: { ...EMPTY_SLOTS, serviceName: 'Routine Checkup' },
      customerName: 'Marcus',
      history: [{ role: 'user', content: 'hello' }],
      requestId: 'req-test-0001',
    });
    assert.match(out.reply, /We're open on Monday, Tuesday, Wednesday, Thursday, Friday, 9:00 AM to 5:00 PM\./);
  });

  it('keeps the draft and does not confirm on an unrelated question', async () => {
    const out = await turn('do you have parking?', complete);
    assert.deepEqual(out.slots, {});
    assert.equal(out.intent, 'collecting');
  });
});

describe('matchService', () => {
  const names = catalogue.map((s) => s.name);

  it('matches the full name case-insensitively', () => {
    assert.equal(matchService('I want a ROUTINE CHECKUP please', names), 'Routine Checkup');
  });

  it('matches on a distinctive word', () => {
    assert.equal(matchService('whitening', names), 'Teeth Whitening');
    assert.equal(matchService('a checkup', names), 'Routine Checkup');
  });

  it('matches "check up" and "check-up" as "checkup"', () => {
    assert.equal(matchService('I need a check up', names), 'Routine Checkup');
    assert.equal(matchService('annual check-up please', names), 'Routine Checkup');
  });

  it('does not match on filler words', () => {
    assert.equal(matchService('hello, I need an appointment for my kid', names), null);
  });

  it('declines to choose when two services match equally well', () => {
    const withCleaning = [...names, 'Teeth Cleaning'];
    assert.equal(matchService('teeth', withCleaning), null);
    // ...but an extra word that breaks the tie is enough to choose.
    assert.equal(matchService('teeth whitening', withCleaning), 'Teeth Whitening');
    assert.equal(matchService('cleaning for my teeth', withCleaning), 'Teeth Cleaning');
  });

  it('copes with an empty catalogue', () => {
    assert.equal(matchService('anything', []), null);
  });
});

describe('fallback intent and replies', () => {
  const draft: Partial<BookingSlots> = { serviceName: 'Routine Checkup', date: '2031-04-22', time: '10:00' };

  it('treats an affirmative as confirmation only when the draft is complete', async () => {
    assert.equal((await turn('yes', draft)).intent, 'confirming');
    assert.equal((await turn('yes please', draft)).intent, 'confirming');
    assert.equal((await turn('book it', draft)).intent, 'confirming');
    assert.equal((await turn('yes', { serviceName: 'Routine Checkup' })).intent, 'collecting');
  });

  it('does not confirm when the user changes their mind', async () => {
    assert.equal((await turn('yes but a different time', draft)).intent, 'collecting');
    assert.equal((await turn('no, another day', draft)).intent, 'collecting');
    assert.equal((await turn('actually change it', draft)).intent, 'collecting');
  });

  // Each of these contains "book", "confirm" or "do it", which alone would read as consent.
  for (const text of [
    "don't book it",
    'please don\u2019t book it yet',
    'wait, do not book it',
    "hold off, don't confirm",
    "I'd rather not book it",
    "don't do it",
    'never mind, stop',
  ]) {
    it(`does not read a negated request as consent: "${text}"`, async () => {
      assert.notEqual((await turn(text, draft)).intent, 'confirming');
    });
  }

  for (const text of ['yes', 'book it', 'go ahead', 'sure, confirm it', 'yes please book that']) {
    it(`still reads a plain affirmative as consent: "${text}"`, async () => {
      assert.equal((await turn(text, draft)).intent, 'confirming');
    });
  }

  it('points a cancellation request at the dashboard instead of pretending to cancel', async () => {
    const out = await turn('I want to cancel my appointment');
    assert.equal(out.intent, 'cancelling');
    assert.match(out.reply, /dashboard/i);
  });

  it('asks only for what is still missing', async () => {
    const needsService = await turn('hello');
    assert.match(needsService.reply, /Which service/);
    assert.match(needsService.reply, /Routine Checkup/);

    const needsDate = await turn('whitening', {});
    assert.match(needsDate.reply, /day and time/i);

    const needsTime = await turn('tomorrow', { serviceName: 'Routine Checkup' });
    assert.match(needsTime.reply, /What time/);
    assert.match(needsTime.reply, /9:00 AM to 5:00 PM/);

    const needsDay = await turn('3pm', { serviceName: 'Routine Checkup' });
    assert.match(needsDay.reply, /Which day/);
  });

  it('summarises the booking and asks before anything is written', async () => {
    const out = await turn('2031-04-22 at 10am', { serviceName: 'Routine Checkup' });
    assert.match(out.reply, /Routine Checkup/);
    assert.match(out.reply, /April 22, 2031/);
    assert.match(out.reply, /10:00 AM/);
    assert.match(out.reply, /Shall I book it\?/);
  });

  it('reports itself as the fallback engine, never as a model', async () => {
    const out = await turn('hello');
    assert.equal(out.engine, 'fallback');
    assert.equal(out.model, undefined);
  });

  it('only reports slots mentioned on this turn, leaving the stored draft to the caller', async () => {
    const out = await turn('make it 3pm', draft);
    assert.deepEqual(out.slots, { time: '15:00' });
  });
});

describe('consent is an allow-list of plain agreement', () => {
  const shown: Partial<BookingSlots> = { serviceName: 'Teeth Whitening', date: '2031-04-22', time: '11:00' };

  for (const [text, agrees] of CONSENT_TABLE) {
    it(`${agrees ? 'agrees' : 'does not agree'}: "${text}"`, async () => {
      assert.equal(isAffirmative(text), agrees);
      assert.equal((await turn(text, shown)).intent === 'confirming', agrees);
    });
  }

  it('answers "Can you confirm the price first?" from the catalogue instead of booking', async () => {
    const out = await turn('Can you confirm the price first?', shown);
    assert.equal(out.intent, 'other', 'an aside: the chat repeats the summary after it');
    assert.equal(out.reply, 'Teeth Whitening takes 60 minutes and costs $199.00.');
  });

  it('updates the time on "yes, but make it 3pm" rather than agreeing', async () => {
    const out = await turn('yes, but make it 3pm', shown);
    assert.equal(out.intent, 'collecting');
    assert.deepEqual(out.slots, { time: '15:00' });
  });

  it('answers a price or length question only for a known catalogue service', () => {
    assert.equal(answerAboutService('how long is it?', 'Routine Checkup', catalogue), 'Routine Checkup takes 30 minutes and has no charge.');
    assert.equal(answerAboutService('how much?', null, catalogue), null);
    assert.equal(answerAboutService('yes please', 'Routine Checkup', catalogue), null);
  });
});
