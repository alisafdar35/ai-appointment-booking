import { Check, Circle, CircleX } from 'lucide-react';
import { passwordSchema } from '@appt/shared';
import { cn } from '@/lib/utils';

/** Messages of every rule the shared password schema reports for `value`. */
function brokenRules(value: string): Set<string> {
  const result = passwordSchema.safeParse(value);
  return new Set(result.success ? [] : result.error.issues.map((issue) => issue.message));
}

/**
 * The requirement list is derived from the shared schema rather than restated,
 * so a rule added to `passwordSchema` shows up here (and in the API's
 * enforcement) without touching this component. An empty string breaks every
 * minimum; an over-long string that satisfies those breaks only the upper
 * bound (bcrypt's 72-byte limit).
 *
 * The minimums are goals, listed from the start. The upper bound is a ceiling
 * almost nobody reaches, so it appears only once broken: listed up front it
 * showed a green tick on an empty field, which reads as progress that is not.
 */
const MINIMUM_RULES = [...brokenRules('')];
const UPPER_BOUND_RULES = [...brokenRules(`Aa1${'x'.repeat(100)}`)].filter((rule) => !MINIMUM_RULES.includes(rule));

interface PasswordChecklistProps {
  value: string;
  /** Target for the password input's aria-describedby, so the rules are read when it is focused. */
  id: string;
  className?: string;
}

/**
 * Live view of the password rules. Each row pairs an icon with sr-only text,
 * so state is never conveyed by colour or shape alone. A separate polite
 * status region announces only the count ("3 of 4 met"), which changes a few
 * times per attempt rather than on every keystroke.
 */
export function PasswordChecklist({ value, id, className }: PasswordChecklistProps) {
  const broken = brokenRules(value);
  const exceeded = UPPER_BOUND_RULES.filter((rule) => broken.has(rule));
  const requirements = [...MINIMUM_RULES, ...exceeded];
  const metCount = requirements.filter((rule) => !broken.has(rule)).length;
  const summary = !value
    ? ''
    : metCount === requirements.length
      ? 'All password requirements met'
      : `${metCount} of ${requirements.length} password requirements met`;

  return (
    <div className={className}>
      <div id={id}>
        <p className="text-sm font-medium text-foreground">Password requirements</p>
        <ul className="mt-2 space-y-1.5">
          {requirements.map((rule) => {
            const met = !broken.has(rule);
            const over = exceeded.includes(rule);
            return (
              <li
                key={rule}
                className={cn(
                  'flex items-center gap-2 text-sm',
                  met ? 'text-success-text' : over ? 'text-danger-text' : 'text-muted-foreground',
                )}
              >
                {met ? (
                  <Check className="size-4 shrink-0" aria-hidden="true" />
                ) : over ? (
                  <CircleX className="size-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Circle className="size-4 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {rule}
                  <span className="sr-only">{met ? ': met' : ': not met yet'}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <p role="status" className="sr-only">
        {summary}
      </p>
    </div>
  );
}
