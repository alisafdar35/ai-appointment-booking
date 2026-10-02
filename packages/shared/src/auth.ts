import { z } from 'zod';

/**
 * bcrypt only ever reads the first 72 BYTES of a password and silently ignores
 * the rest, so two long passwords sharing a 72-byte prefix would be the same
 * password. The limit is in bytes, not characters: an accented letter is two
 * bytes in UTF-8 and an emoji four. Counted by hand rather than with
 * TextEncoder so the rule needs nothing from the runtime it is evaluated in.
 */
const BCRYPT_MAX_BYTES = 72;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Password policy lives here so the signup form and the API cannot disagree
 * about it — the form shows the rule, the API enforces the same object.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Must be at least 10 characters')
  .regex(/[a-z]/, 'Must contain a lowercase letter')
  .regex(/[A-Z]/, 'Must contain an uppercase letter')
  .regex(/[0-9]/, 'Must contain a number')
  .refine(
    (v) => utf8ByteLength(v) <= BCRYPT_MAX_BYTES,
    'Must be at most 72 bytes (about 72 letters, fewer with accents or emoji)',
  );

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address')
  .transform((v) => v.toLowerCase());

/**
 * An optional text field as a form submits it. An untouched input arrives as
 * "" (or whitespace), which means "not given" — not "given, and invalid".
 */
const optionalText = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : v))
    .pipe(schema.optional())
    .optional();

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(1, 'Required').max(160),
  phone: optionalText(z.string().regex(/^\+?[0-9 ()-]{6,24}$/, 'Enter a valid phone number')),
  /**
   * Joining an existing tenant by slug. Omitted means "create a new business",
   * which is how a self-serve SaaS signup actually behaves.
   */
  businessSlug: optionalText(
    z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Lowercase letters, numbers and hyphens only'),
  ),
  businessName: optionalText(z.string().max(160)),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  // Deliberately NOT passwordSchema: a tightened policy must never lock out an
  // existing user, and echoing policy rules on login leaks nothing useful.
  password: z.string().min(1, 'Required').max(200),
  businessSlug: optionalText(z.string()),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const USER_ROLES = ['owner', 'staff', 'customer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Safe user projection. Never carries password_hash — see the repository layer. */
export interface UserDto {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
  businessId: string;
  businessName: string;
  businessSlug: string;
  businessTimezone: string;
  createdAt: string;
}

export interface AuthResponse {
  user: UserDto;
  /** Short-lived. Also set as an httpOnly cookie; returned for non-browser clients. */
  accessToken: string;
  expiresInSeconds: number;
}
