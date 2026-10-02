import { describe, expect, it } from 'vitest';
import { signupFormSchema, toSignupInput, type SignupFormInput } from './signup-schema';

const account = {
  fullName: 'Casey Customer',
  email: 'Casey@Example.test',
  password: 'Sufficient1password',
  phone: '',
};

const create = (overrides: Partial<SignupFormInput> = {}): SignupFormInput => ({
  ...account,
  mode: 'create',
  businessName: 'Casey Dental',
  businessSlug: '',
  ...overrides,
});

const join = (overrides: Partial<SignupFormInput> = {}): SignupFormInput => ({
  ...account,
  mode: 'join',
  businessName: '',
  businessSlug: 'bluewave',
  ...overrides,
});

function fieldErrors(input: SignupFormInput) {
  const result = signupFormSchema.safeParse(input);
  return result.success ? {} : result.error.flatten().fieldErrors;
}

describe('signupFormSchema', () => {
  it('accepts a new-business signup and a join signup', () => {
    expect(signupFormSchema.safeParse(create()).success).toBe(true);
    expect(signupFormSchema.safeParse(join()).success).toBe(true);
  });

  it('requires a business name only when creating a business', () => {
    expect(fieldErrors(create({ businessName: '  ' }))).toEqual({ businessName: ['Enter your business name'] });
    expect(fieldErrors(join({ businessName: '' }))).toEqual({});
  });

  it('requires a business code only when joining, and applies the shared slug rule', () => {
    expect(fieldErrors(join({ businessSlug: '' }))).toEqual({ businessSlug: ["Enter the business's code"] });
    // The shared rule reads a blank code as "not given"; here that still means missing.
    expect(fieldErrors(join({ businessSlug: '   ' }))).toEqual({ businessSlug: ["Enter the business's code"] });
    expect(fieldErrors(join({ businessSlug: 'Blue Wave' }))).toEqual({
      businessSlug: ['Lowercase letters, numbers and hyphens only'],
    });
    expect(fieldErrors(create({ businessSlug: 'Not A Slug' }))).toEqual({});
  });

  it('enforces the shared password policy', () => {
    expect(fieldErrors(create({ password: 'short' })).password).toContain('Must be at least 10 characters');
  });

  it('applies the shared 72-byte password limit, counting bytes rather than letters', () => {
    const tooLong = /at most 72 bytes/;
    expect(fieldErrors(create({ password: `Aa1${'x'.repeat(69)}` })).password).toBeUndefined();
    expect(fieldErrors(create({ password: `Aa1${'x'.repeat(70)}` })).password).toEqual([expect.stringMatching(tooLong)]);
    // 40 letters, but each "é" is two bytes in UTF-8.
    expect(fieldErrors(create({ password: `Aa1${'é'.repeat(37)}` })).password).toEqual([expect.stringMatching(tooLong)]);
  });
});

describe('toSignupInput', () => {
  it('sends only the business field for the chosen mode, with the email normalised', () => {
    const created = toSignupInput(signupFormSchema.parse(create()));
    expect(created).toMatchObject({ email: 'casey@example.test', businessName: 'Casey Dental' });
    expect(created).not.toHaveProperty('businessSlug');
    expect(created).not.toHaveProperty('mode');

    const joined = toSignupInput(signupFormSchema.parse(join()));
    expect(joined).toMatchObject({ businessSlug: 'bluewave' });
    expect(joined).not.toHaveProperty('businessName');
  });

  it('omits a blank phone number, as the shared schema reads it', () => {
    expect(toSignupInput(signupFormSchema.parse(create())).phone).toBeUndefined();
    expect(toSignupInput(signupFormSchema.parse(create({ phone: '   ' }))).phone).toBeUndefined();
  });
});
