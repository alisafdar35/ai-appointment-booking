import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EMPTY_SLOTS,
  bookingSlotsSchema,
  isBookingComplete,
  mergeSlots,
  missingSlots,
  type BookingSlots,
} from '@appt/shared';

/**
 * mergeSlots is the rule that makes a multi-turn conversation work: each turn
 * carries only what the user said THIS turn, and the draft accumulates. The
 * dangerous bug is the inverse, where "nothing said" wipes what was known.
 */
describe('mergeSlots', () => {
  const draft: BookingSlots = { serviceName: 'Routine Checkup', date: '2031-04-22', time: '10:00', notes: 'First visit' };

  it('starts from the empty draft', () => {
    assert.deepEqual(mergeSlots(null, null), EMPTY_SLOTS);
    assert.deepEqual(mergeSlots(undefined, undefined), EMPTY_SLOTS);
  });

  it('adds newly mentioned slots to an existing draft', () => {
    const merged = mergeSlots({ serviceName: 'Routine Checkup' }, { date: '2031-04-22' });
    assert.deepEqual(merged, { ...EMPTY_SLOTS, serviceName: 'Routine Checkup', date: '2031-04-22' });
  });

  it('lets a correction replace one slot and keeps the rest', () => {
    // "actually make it 3pm"
    assert.deepEqual(mergeSlots(draft, { time: '15:00' }), { ...draft, time: '15:00' });
  });

  it('never clears a slot because the patch left it null or undefined', () => {
    assert.deepEqual(mergeSlots(draft, { serviceName: null, date: undefined, time: null, notes: null }), draft);
  });

  it('treats an empty string as "not mentioned", not as a value', () => {
    assert.deepEqual(mergeSlots(draft, { notes: '', time: '' }), draft);
  });

  it('does not mutate either argument', () => {
    const current = { ...draft };
    const patch = { time: '15:00' };
    mergeSlots(current, patch);
    assert.deepEqual(current, draft);
    assert.deepEqual(patch, { time: '15:00' });
    assert.deepEqual(EMPTY_SLOTS, { serviceName: null, date: null, time: null, notes: null });
  });

  it('ignores keys that are not booking slots', () => {
    const merged = mergeSlots(draft, { reply: 'hello', intent: 'confirming' } as never);
    assert.deepEqual(merged, draft);
  });

  it('fills a partial stored draft with nulls', () => {
    // A session row created before a field existed has a sparse jsonb object.
    assert.deepEqual(mergeSlots({ date: '2031-04-22' }, {}), { ...EMPTY_SLOTS, date: '2031-04-22' });
  });
});

describe('missingSlots / isBookingComplete', () => {
  it('lists every required slot for an empty or absent draft, in booking order', () => {
    assert.deepEqual(missingSlots(null), ['serviceName', 'date', 'time']);
    assert.deepEqual(missingSlots(undefined), ['serviceName', 'date', 'time']);
    assert.deepEqual(missingSlots(EMPTY_SLOTS), ['serviceName', 'date', 'time']);
  });

  it('lists only what is still missing', () => {
    assert.deepEqual(missingSlots({ serviceName: 'Routine Checkup' }), ['date', 'time']);
    assert.deepEqual(missingSlots({ serviceName: 'Routine Checkup', time: '10:00' }), ['date']);
  });

  it('does not require notes', () => {
    const slots = { serviceName: 'Routine Checkup', date: '2031-04-22', time: '10:00', notes: null };
    assert.deepEqual(missingSlots(slots), []);
    assert.equal(isBookingComplete(slots), true);
  });

  it('counts an empty string as missing', () => {
    assert.deepEqual(missingSlots({ serviceName: '', date: '2031-04-22', time: '10:00' }), ['serviceName']);
  });

  it('is incomplete until all three required slots are present', () => {
    assert.equal(isBookingComplete({ serviceName: 'Routine Checkup', date: '2031-04-22' }), false);
    assert.equal(isBookingComplete(null), false);
  });
});

describe('bookingSlotsSchema', () => {
  it('defaults every slot to null so a draft is always a complete object', () => {
    assert.deepEqual(bookingSlotsSchema.parse({}), EMPTY_SLOTS);
  });

  it('rejects malformed times and dates', () => {
    for (const time of ['2pm', '14:60', '24:00', '9:00', '14.30']) {
      assert.equal(bookingSlotsSchema.safeParse({ time }).success, false, `time ${time}`);
    }
    for (const date of ['next friday', '2031-4-22', '22/04/2031', '2031-13-01']) {
      assert.equal(bookingSlotsSchema.safeParse({ date }).success, false, `date ${date}`);
    }
  });
});
