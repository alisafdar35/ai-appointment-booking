import { z } from 'zod';

/**
 * Wording for the shared schemas' rules that carry no message of their own
 * (e.g. `emailSchema`'s `.min(3)`). Zod's default for those is "String must
 * contain at least 3 character(s)", which is accurate but meaningless to
 * someone who simply left the field empty.
 *
 * Messages written into the schemas still win: this map is only the fallback.
 * The one message-less string minimum in the auth schemas is the email's, which
 * is why a too-short non-empty value reads as an invalid email address.
 */
const authErrorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_type && issue.received === 'undefined') {
    return { message: 'Required' };
  }
  if (issue.code === z.ZodIssueCode.too_small && issue.type === 'string') {
    return { message: ctx.data === '' ? 'Required' : 'Enter a valid email address' };
  }
  return { message: ctx.defaultError };
};

/**
 * Parse options for `zodResolver(schema, authParseOptions)`. Zod types every
 * field of ParseParams as required, so path and async are spelled out with
 * their defaults rather than cast away.
 */
export const authParseOptions: z.ParseParams = { errorMap: authErrorMap, path: [], async: false };
