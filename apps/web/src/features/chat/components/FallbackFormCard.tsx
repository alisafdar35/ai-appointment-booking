'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { AssistantTurnDto, BookingSlots } from '@appt/shared';
import { Alert, type AlertTone } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DateField } from '@/features/booking/DateField';
import { SlotPicker } from '@/features/booking/SlotPicker';
import { errorMessage } from '@/lib/api';
import { todayInZone } from '@/lib/datetime';
import { applyApiFieldErrors } from '@/lib/form-errors';
import { queryKeys, useServices } from '@/lib/queries';
import { formatPrice } from '@/lib/utils';
import { useBusinessTimezone } from '@/providers/AuthProvider';
import {
  FORM_REASON_COPY,
  createFallbackFormSchema,
  toFormValues,
  type FallbackFormValues,
  type FormReason,
} from '../lib/fallback-form';

interface FallbackFormCardProps {
  reason: FormReason;
  /** The server's draft: the form starts from what the conversation already understood. */
  draft: BookingSlots;
  /**
   * Resolves with the assistant's turn, booked or not; rejects only with
   * validation, closed-conversation or transport errors.
   */
  onSubmit: (slots: Partial<BookingSlots>) => Promise<AssistantTurnDto>;
  /** The booking went through; the transcript already shows the result. */
  onBooked: () => void;
  onClose: () => void;
}

interface Notice {
  tone: AlertTone;
  text: string;
}

/**
 * The structured way to finish a booking when typing is not working out, or is
 * simply not what the user prefers. It is not a separate booking path: it
 * submits to the conversation, so the result lands in the same transcript and
 * goes through the same availability checks as a chat booking.
 *
 * Validated with the shared zod pieces, so the client and the API cannot
 * disagree about what a valid date or time is.
 */
export function FallbackFormCard({ reason, draft, onSubmit, onBooked, onClose }: FallbackFormCardProps) {
  const timeZone = useBusinessTimezone();
  const queryClient = useQueryClient();
  const services = useServices();
  const [notice, setNotice] = useState<Notice | null>(null);

  const today = todayInZone(timeZone);
  const schema = useMemo(() => createFallbackFormSchema(today), [today]);
  const form = useForm<FallbackFormValues>({
    resolver: zodResolver(schema),
    defaultValues: toFormValues(draft),
  });
  const { control, register, handleSubmit, setError, setValue, reset, watch, formState } = form;
  const { errors, isSubmitting } = formState;

  // A turn can change the draft while the form is open. Fields the user has not
  // touched follow it; anything they typed stays.
  const draftSignature = JSON.stringify(draft);
  useEffect(() => {
    reset(toFormValues(JSON.parse(draftSignature) as BookingSlots), { keepDirtyValues: true });
  }, [draftSignature, reset]);

  const [serviceName, date, time] = watch(['serviceName', 'date', 'time']);
  const service = services.data?.find((candidate) => candidate.name === serviceName);

  const refreshSlots = () => {
    if (service) void queryClient.invalidateQueries({ queryKey: queryKeys.availability.forService(service.id) });
  };

  const submit = handleSubmit(async (values) => {
    setNotice(null);
    try {
      const turn = await onSubmit({
        serviceName: values.serviceName,
        date: values.date,
        time: values.time,
        notes: values.notes || undefined,
      });
      if (turn.action === 'booked') {
        onBooked();
        return;
      }
      // Not booked, but not an error either: the server kept what was fine,
      // cleared what was not (a time lost to another booking, say), and
      // explained it in the transcript above.
      refreshSlots();
      reset(toFormValues(turn.bookingDraft));
      if (values.time && !turn.bookingDraft.time) {
        setError('time', { type: 'server', message: 'Pick another time from the list.' });
      }
      setNotice({ tone: 'warning', text: turn.message.content });
    } catch (error) {
      if (!applyApiFieldErrors(error, setError)) setNotice({ tone: 'error', text: errorMessage(error) });
    }
  });

  return (
    <section
      id="booking-form"
      aria-labelledby="booking-form-title"
      className="animate-rise-in rounded-xl border border-accent-border bg-surface shadow-card"
    >
      <header className="flex items-start gap-3 border-b border-border px-4 py-4 sm:px-5">
        <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent-text">
          <ListChecks className="size-4" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <h3 id="booking-form-title" className="text-sm font-semibold text-foreground">
            Book with a quick form
          </h3>
          <p className="text-sm text-muted-foreground">{FORM_REASON_COPY[reason]}</p>
        </div>
      </header>

      <form onSubmit={submit} noValidate className="space-y-4 px-4 py-4 sm:px-5">
        {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

        {services.isError ? (
          <Alert
            tone="error"
            title="We couldn't load the services"
            action={
              <Button size="sm" variant="secondary" loading={services.isFetching} onClick={() => services.refetch()}>
                Try again
              </Button>
            }
          >
            {errorMessage(services.error)}
          </Alert>
        ) : null}

        {/* Controlled: the options arrive after the form mounts, and an uncontrolled select would not re-apply the prefilled value. */}
        <Controller
          control={control}
          name="serviceName"
          render={({ field }) => (
            <FormField label="Service" required error={errors.serviceName?.message}>
              <Select
                name={field.name}
                value={field.value}
                onBlur={field.onBlur}
                disabled={services.isPending}
                onChange={(event) => {
                  field.onChange(event.target.value);
                  // Availability depends on the service, so a time chosen for another one no longer applies.
                  setValue('time', '');
                }}
              >
                <option value="">{services.isPending ? 'Loading services…' : 'Choose a service'}</option>
                {services.data?.map((option) => (
                  <option key={option.id} value={option.name}>
                    {option.name} · {option.durationMinutes} min · {formatPrice(option.priceCents)}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        />

        <Controller
          control={control}
          name="date"
          render={({ field }) => (
            <DateField
              label="Date"
              required
              name={field.name}
              value={field.value}
              onBlur={field.onBlur}
              onChange={(next) => {
                field.onChange(next);
                setValue('time', '');
              }}
              error={errors.date?.message}
            />
          )}
        />

        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">
            Time
            <span aria-hidden="true" className="ml-0.5 text-danger-text">
              *
            </span>
          </p>
          <SlotPicker
            serviceId={service?.id}
            date={date || null}
            value={time || null}
            label="Time"
            disabled={isSubmitting}
            // Dirty, so a turn that changes the draft while the form is open cannot replace the user's pick.
            onChange={(next) => setValue('time', next, { shouldValidate: true, shouldDirty: true })}
          />
          {errors.time?.message ? (
            <p role="alert" className="text-sm text-danger-text">
              {errors.time.message}
            </p>
          ) : null}
        </div>

        <FormField label="Notes" hint="Optional. Anything we should know before your visit." error={errors.notes?.message}>
          <Textarea rows={2} {...register('notes')} />
        </FormField>

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>
            Back to chat
          </Button>
          <Button type="submit" loading={isSubmitting}>
            Book appointment
          </Button>
        </div>
      </form>
    </section>
  );
}
