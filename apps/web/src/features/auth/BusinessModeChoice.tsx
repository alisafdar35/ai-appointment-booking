import type { UseFormRegisterReturn } from 'react-hook-form';
import type { BusinessMode } from './signup-schema';

// Join first: most people signing up are customers of a business already on Slotly.
const OPTIONS: { value: BusinessMode; label: string }[] = [
  { value: 'join', label: 'Join an existing business' },
  { value: 'create', label: 'Create a new business' },
];

/**
 * Segmented choice built from native radio inputs, so arrow-key navigation,
 * grouping and form state come from the browser. The inputs are visually
 * hidden and the adjacent label carries the selected style via `peer-checked`.
 */
export function BusinessModeChoice({ registration }: { registration: UseFormRegisterReturn<'mode'> }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">What brings you to Slotly?</legend>
      <div className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-muted p-1">
        {OPTIONS.map(({ value, label }) => (
          <label key={value} className="relative cursor-pointer">
            <input type="radio" value={value} className="peer sr-only" {...registration} />
            <span className="flex min-h-11 items-center justify-center rounded-lg px-2 text-center text-sm font-medium leading-tight text-muted-foreground transition-colors hover:text-foreground peer-checked:bg-surface peer-checked:text-foreground peer-checked:shadow-card peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
              {label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
