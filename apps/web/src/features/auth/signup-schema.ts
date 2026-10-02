import { signupSchema, type SignupInput } from '@appt/shared';
import { z, type RefinementCtx } from 'zod';

export const BUSINESS_MODES = ['create', 'join'] as const;
export type BusinessMode = (typeof BUSINESS_MODES)[number];

/**
 * The sign-up form's schema: the shared one for every field the API validates,
 * plus the form-only `mode` that decides which business field is required.
 *
 * The server treats businessName and businessSlug as independent optionals
 * (omitted slug means "create a business"); the form has to make one of them
 * mandatory, which is a UI concern and so lives here. Rules for the values
 * themselves still come from `signupSchema`, so they cannot drift.
 */
export const signupFormSchema = signupSchema
  .pick({ fullName: true, email: true, password: true, phone: true })
  .extend({
    mode: z.enum(BUSINESS_MODES),
    // Both are always present as strings (the inputs are controlled by the
    // form); only the one matching `mode` is validated and sent.
    businessName: z.string(),
    businessSlug: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.mode === 'create') {
      requireWithSharedRule(ctx, 'businessName', values.businessName, 'Enter your business name');
    } else {
      requireWithSharedRule(ctx, 'businessSlug', values.businessSlug, "Enter the business's code");
    }
  });

export type SignupFormInput = z.input<typeof signupFormSchema>;
export type SignupFormValues = z.output<typeof signupFormSchema>;

/**
 * The shared rule trims the value and reads a blank one as "not given", which
 * the API accepts. On this form the field matching the mode must be given, so
 * a value the shared rule turns into "not given" is reported as missing.
 */
function requireWithSharedRule(
  ctx: RefinementCtx,
  field: 'businessName' | 'businessSlug',
  value: string,
  requiredMessage: string,
) {
  const result = signupSchema.shape[field].safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: issue.message });
    }
  } else if (result.data === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: requiredMessage });
  }
}

/**
 * The request body for the API: only the business field that matches the
 * chosen mode. Values go as typed; the API's schema trims them.
 */
export function toSignupInput({ mode, businessName, businessSlug, ...account }: SignupFormValues): SignupInput {
  return mode === 'create' ? { ...account, businessName } : { ...account, businessSlug };
}
