import { zodResolver } from '@hookform/resolvers/zod';
import { useId, useMemo, useState } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { Controller, useForm } from 'react-hook-form';
import type { AppointmentDto } from '@appt/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { FormField } from '@/components/ui/FormField';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Textarea';
import { errorMessage } from '@/lib/api';
import { formatDateTime, todayInZone } from '@/lib/datetime';
import { applyApiFieldErrors } from '@/lib/form-errors';
import { useCreateAppointment, useServices } from '@/lib/queries';
import { useBusinessTimezone } from '@/providers/AuthProvider';
import { useToast } from '@/providers/ToastProvider';
import { DateField } from '@/features/booking/DateField';
import { SlotPicker } from '@/features/booking/SlotPicker';
import { BookingSummary } from './BookingSummary';
import { CharacterCount } from './CharacterCount';
import { FieldGroup } from './FieldGroup';
import { ServicePicker } from './ServicePicker';
import {
  classifyBookingError,
  createBookingFormSchema,
  type BookingFormData,
  type BookingFormValues,
} from './lib/booking';

const NOTES_MAX = 2000; // createAppointmentSchema's limit

interface BookingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the confirmed appointment, after the dialog has toasted and closed. */
  onBooked: (appointment: AppointmentDto) => void;
}

export function BookingDialog({ open, onOpenChange, onBooked }: BookingDialogProps) {
  // Subscribing while closed warms the cache, so the options are already
  // on screen (and focusable) the moment the dialog opens.
  useServices();
  // The body only exists while open, so each booking starts from a blank form.
  return open ? <BookingDialogBody onOpenChange={onOpenChange} onBooked={onBooked} /> : null;
}

/** The service cards, or the skeleton / retry that stands in for them. */
function ServiceOptions({
  query,
  registration,
  invalid,
}: {
  query: ReturnType<typeof useServices>;
  registration: UseFormRegisterReturn;
  invalid: boolean;
}) {
  if (query.isPending) {
    return (
      <div role="status" className="grid gap-2">
        <span className="sr-only">Loading services</span>
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-[4.5rem] rounded-xl" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert
        tone="error"
        title="We couldn't load the services"
        action={
          <Button size="sm" variant="secondary" loading={query.isFetching} onClick={() => query.refetch()}>
            Try again
          </Button>
        }
      >
        {errorMessage(query.error)}
      </Alert>
    );
  }
  return <ServicePicker services={query.data} registration={registration} invalid={invalid} />;
}

function BookingDialogBody({ onOpenChange, onBooked }: Omit<BookingDialogProps, 'open'>) {
  const formId = useId();
  const timezone = useBusinessTimezone();
  const toast = useToast();
  const services = useServices();
  const create = useCreateAppointment();
  const [formError, setFormError] = useState<string | null>(null);

  // Fixed for the lifetime of the dialog: the schema must not change under a form mid-edit.
  const schema = useMemo(() => createBookingFormSchema(todayInZone(timezone)), [timezone]);
  const {
    register,
    control,
    handleSubmit,
    setValue,
    setError,
    clearErrors,
    watch,
    formState: { errors },
  } = useForm<BookingFormValues, unknown, BookingFormData>({
    resolver: zodResolver(schema),
    defaultValues: { serviceId: '', date: '', time: '', notes: '', source: 'form' },
  });

  const [serviceId, date, time, notes] = watch(['serviceId', 'date', 'time', 'notes']);
  const service = services.data?.find((candidate) => candidate.id === serviceId);

  // A time belongs to one service on one date; once either changes it means nothing.
  const forgetTime = () => {
    setValue('time', '');
    clearErrors('time');
  };

  const onSubmit = async (values: BookingFormData) => {
    if (create.isPending) return; // Enter in a field can submit again while a request is in flight
    setFormError(null);
    try {
      const appointment = await create.mutateAsync({ ...values, notes: values.notes || undefined });
      toast.success(formatDateTime(appointment.startsAt, timezone), { title: `${appointment.service.name} booked` });
      onOpenChange(false);
      onBooked(appointment);
    } catch (error) {
      const failure = classifyBookingError(error);
      switch (failure.kind) {
        case 'slot-taken':
          // useCreateAppointment has already refetched availability; drop the stale choice.
          setValue('time', '');
          setError('time', { type: 'server', message: failure.message });
          break;
        case 'time':
          setError('time', { type: 'server', message: failure.message });
          break;
        case 'validation':
          if (!applyApiFieldErrors(error, setError)) setFormError(errorMessage(error));
          break;
        case 'form':
          setFormError(failure.message);
          break;
      }
    }
  };

  const notesLength = (notes ?? '').length;
  const notesError =
    notesLength > NOTES_MAX ? `Keep your notes to ${NOTES_MAX} characters or fewer.` : errors.notes?.message;

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      dismissible={!create.isPending}
      size="lg"
      title="New appointment"
      description="Choose a service, a day and a time. Your booking is confirmed straight away."
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            Book appointment
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-5">
        {formError ? (
          <Alert tone="error" title="We couldn't book that appointment" onDismiss={() => setFormError(null)}>
            {formError}
          </Alert>
        ) : null}

        <FieldGroup label="Service" required error={errors.serviceId?.message}>
          <ServiceOptions
            query={services}
            invalid={Boolean(errors.serviceId)}
            registration={register('serviceId', { onChange: forgetTime })}
          />
        </FieldGroup>

        <Controller
          control={control}
          name="date"
          render={({ field, fieldState }) => (
            <DateField
              label="Date"
              required
              name={field.name}
              value={field.value}
              error={fieldState.error?.message}
              onBlur={field.onBlur}
              onChange={(next) => {
                field.onChange(next);
                forgetTime();
              }}
            />
          )}
        />

        <FieldGroup label="Time" required error={errors.time?.message}>
          <Controller
            control={control}
            name="time"
            render={({ field }) => (
              <SlotPicker
                serviceId={serviceId || null}
                date={date || null}
                value={field.value || null}
                onChange={(next) => {
                  field.onChange(next);
                  clearErrors('time');
                }}
              />
            )}
          />
        </FieldGroup>

        <div>
          <FormField label="Notes (optional)" error={notesError}>
            <Textarea rows={3} placeholder="Anything the business should know beforehand" {...register('notes')} />
          </FormField>
          <CharacterCount length={notesLength} max={NOTES_MAX} />
        </div>

        <BookingSummary service={service} date={date} time={time} timezone={timezone} />
      </form>
    </Dialog>
  );
}
