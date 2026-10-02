import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from '@/lib/api';

/**
 * Copy the server's field-level validation messages onto a react-hook-form
 * instance, so a rule the client schema did not catch (or an API-only rule such
 * as "email already registered") still lands next to the field it concerns.
 *
 * Returns true when at least one message was applied; when it returns false the
 * caller should show `error.message` in a form-level Alert instead.
 */
export function applyApiFieldErrors<T extends FieldValues>(error: unknown, setError: UseFormSetError<T>): boolean {
  if (!(error instanceof ApiError) || !error.details) return false;
  let applied = false;
  for (const [field, messages] of Object.entries(error.details)) {
    const message = messages[0];
    if (!message) continue;
    setError(field as Path<T>, { type: 'server', message });
    applied = true;
  }
  return applied;
}
