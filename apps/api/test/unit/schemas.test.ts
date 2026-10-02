import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isRealCalendarDate,
  isoDateSchema,
  listAppointmentsSchema,
  loginSchema,
  passwordSchema,
  signupSchema,
} from '@appt/shared';

/**
 * The shared schemas are enforced twice — by the web forms and by the API — so
 * a rule here is a contract with both. These pin the rules that are easy to get
 * subtly wrong: calendar validity, bcrypt's byte limit, and what a blank form
 * field means.
 */

describe('isRealCalendarDate', () => {
  it('accepts real dates, including a leap day', () => {
    assert.equal(isRealCalendarDate('2026-10-09'), true);
    assert.equal(isRealCalendarDate('2028-02-29'), true);
    assert.equal(isRealCalendarDate('2026-12-31'), true);
  });

  it('rejects days that the engine would silently roll over into the next month', () => {
    assert.equal(isRealCalendarDate('2026-02-31'), false);
    assert.equal(isRealCalendarDate('2027-02-29'), false);
    assert.equal(isRealCalendarDate('2026-04-31'), false);
  });

  it('rejects impossible months and days', () => {
    assert.equal(isRealCalendarDate('2026-13-01'), false);
    assert.equal(isRealCalendarDate('2026-00-10'), false);
    assert.equal(isRealCalendarDate('2026-10-00'), false);
    assert.equal(isRealCalendarDate('not-a-date'), false);
  });
});

describe('isoDateSchema', () => {
  it('rejects a well-formed date that does not exist, so it never reaches Postgres', () => {
    const result = isoDateSchema.safeParse('2026-02-31');
    assert.equal(result.success, false);
    assert.equal(result.error?.issues[0]?.message, 'Not a real date');
  });

  it('accepts a real date and still insists on the format', () => {
    assert.equal(isoDateSchema.safeParse('2028-02-29').success, true);
    assert.equal(isoDateSchema.safeParse('2026-9-1').success, false);
  });
});

describe('passwordSchema', () => {
  const issues = (password: string) => passwordSchema.safeParse(password).error?.issues.map((i) => i.message) ?? [];

  it('allows exactly 72 bytes, bcrypt’s limit', () => {
    assert.deepEqual(issues(`Aa1${'x'.repeat(69)}`), []);
  });

  it('refuses 73 bytes, which bcrypt would silently truncate', () => {
    assert.deepEqual(issues(`Aa1${'x'.repeat(70)}`), [
      'Must be at most 72 bytes (about 72 letters, fewer with accents or emoji)',
    ]);
  });

  it('counts bytes, not characters: 40 accented letters are 80 bytes', () => {
    const password = `Aa1${'é'.repeat(40)}`;
    assert.equal(password.length, 43);
    assert.equal(issues(password).length, 1);
  });

  it('counts an emoji as four bytes', () => {
    assert.deepEqual(issues(`Aa1${'x'.repeat(65)}😀`), [], '68 + 4 = 72');
    assert.equal(issues(`Aa1${'x'.repeat(66)}😀`).length, 1, '69 + 4 = 73');
  });

  it('is not applied at login, so a tightened policy cannot lock an existing user out', () => {
    const long = loginSchema.safeParse({ email: 'a@b.test', password: 'x'.repeat(150) });
    assert.equal(long.success, true);
  });
});

describe('signupSchema', () => {
  const base = { email: 'new@example.test', password: 'Sup3rSecretPass', fullName: 'New Person' };

  it('treats blank business fields and phone as absent, as an untouched form input arrives', () => {
    const parsed = signupSchema.parse({ ...base, businessSlug: '', businessName: '   ', phone: ' ' });
    assert.equal(parsed.businessSlug, undefined);
    assert.equal(parsed.businessName, undefined);
    assert.equal(parsed.phone, undefined);
  });

  it('still validates a business slug that was actually given', () => {
    const result = signupSchema.safeParse({ ...base, businessSlug: 'Not A Slug' });
    assert.equal(result.success, false);
    assert.deepEqual(result.error?.issues[0]?.path, ['businessSlug']);
  });

  it('trims what it keeps', () => {
    const parsed = signupSchema.parse({ ...base, businessSlug: ' bluewave ', businessName: ' Acme ' });
    assert.equal(parsed.businessSlug, 'bluewave');
    assert.equal(parsed.businessName, 'Acme');
  });
});

describe('listAppointmentsSchema status filter', () => {
  const status = (value: string) => listAppointmentsSchema.safeParse({ status: value });

  it('accepts a single status, as before', () => {
    assert.deepEqual(status('confirmed').data?.status, ['confirmed']);
  });

  it('accepts a comma-separated list, ignoring stray spaces and empty entries', () => {
    assert.deepEqual(status('pending, confirmed,').data?.status, ['pending', 'confirmed']);
  });

  it('rejects any value that is not a known status', () => {
    assert.equal(status('pending,archived').success, false);
    assert.equal(status(',').success, false);
  });
});
