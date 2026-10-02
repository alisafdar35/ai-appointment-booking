import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

interface FieldGroupProps {
  /** Visible heading for a group of controls that a single <label> cannot describe (radio cards, a slot grid). */
  label: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}

/**
 * The visual twin of FormField for composite controls: same label weight and
 * the same announced error, but the label is a heading rather than a
 * `<label for>`, because the controls inside name themselves (a radiogroup
 * with its own aria-label).
 */
export function FieldGroup({ label, error, required, children }: FieldGroupProps) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-foreground">
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-0.5 text-danger-text">
            *
          </span>
        ) : null}
      </p>
      {children}
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-danger-text">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
