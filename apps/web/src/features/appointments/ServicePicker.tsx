import type { UseFormRegisterReturn } from 'react-hook-form';
import type { ServiceDto } from '@appt/shared';
import { formatPrice } from '@/lib/utils';

interface ServicePickerProps {
  services: readonly ServiceDto[];
  /** From react-hook-form's `register('serviceId')`, so the radios are the form's own inputs. */
  registration: UseFormRegisterReturn;
  invalid: boolean;
}

/**
 * Services as selectable cards. Underneath they are native radio inputs: the
 * browser supplies arrow-key navigation, a single Tab stop and the checked
 * state, and the card is only a larger, prettier label for each one.
 */
export function ServicePicker({ services, registration, invalid }: ServicePickerProps) {
  return (
    <div role="radiogroup" aria-label="Service" aria-required="true" aria-invalid={invalid || undefined} className="grid gap-2">
      {services.map((service, index) => (
        <label
          key={service.id}
          className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border bg-surface p-3.5 transition-colors hover:border-accent has-[:checked]:border-accent has-[:checked]:bg-accent-subtle has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
        >
          <input
            type="radio"
            value={service.id}
            // The dialog focuses this on open, so the first keystroke already works on the form.
            data-autofocus={index === 0 ? true : undefined}
            className="peer sr-only"
            {...registration}
          />
          <span
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 rounded-full border border-input bg-surface transition-colors peer-checked:border-accent peer-checked:bg-accent peer-checked:shadow-[inset_0_0_0_3px_rgb(var(--surface))]"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-foreground">{service.name}</span>
              <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
                {formatPrice(service.priceCents)}
              </span>
            </span>
            <span className="mt-0.5 block text-sm tabular-nums text-muted-foreground">{service.durationMinutes} min</span>
            {service.description ? (
              <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{service.description}</span>
            ) : null}
          </span>
        </label>
      ))}
    </div>
  );
}
