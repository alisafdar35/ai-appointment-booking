import { zodResolver } from '@hookform/resolvers/zod';
import { useId } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ERROR_CODES, cancelAppointmentSchema, type AppointmentDto } from '@appt/shared';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { FormField } from '@/components/ui/FormField';
import { Textarea } from '@/components/ui/Textarea';
import { errorMessage, hasErrorCode } from '@/lib/api';
import { formatDate, formatTimeRange } from '@/lib/datetime';
import { useCancelAppointment } from '@/lib/queries';
import { useBusinessTimezone } from '@/providers/AuthProvider';
import { useToast } from '@/providers/ToastProvider';
import { CharacterCount } from './CharacterCount';

const REASON_MAX = 500; // cancelAppointmentSchema's limit; shown so the counter and the rule agree

type CancelFormValues = z.input<typeof cancelAppointmentSchema>;

interface CancelDialogProps {
  /** The appointment being cancelled; null keeps the dialog closed. */
  appointment: AppointmentDto | null;
  onOpenChange: (open: boolean) => void;
  /** Called once the server has confirmed, after the dialog's own toast. */
  onCancelled: () => void;
}

export function CancelDialog({ appointment, onOpenChange, onCancelled }: CancelDialogProps) {
  // Mounting the body only while open gives every cancellation a fresh form.
  return appointment ? (
    <CancelDialogBody
      key={appointment.id}
      appointment={appointment}
      onOpenChange={onOpenChange}
      onCancelled={onCancelled}
    />
  ) : null;
}

function CancelDialogBody({
  appointment,
  onOpenChange,
  onCancelled,
}: Omit<CancelDialogProps, 'appointment'> & { appointment: AppointmentDto }) {
  const formId = useId();
  const timezone = useBusinessTimezone();
  const toast = useToast();
  const cancel = useCancelAppointment();
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<CancelFormValues>({ resolver: zodResolver(cancelAppointmentSchema), defaultValues: { reason: '' } });

  const reasonLength = (watch('reason') ?? '').length;
  const reasonError =
    reasonLength > REASON_MAX ? `Keep the reason to ${REASON_MAX} characters or fewer.` : errors.reason?.message;
  const day = formatDate(appointment.startsAt, timezone, 'short');
  const when = `${day} · ${formatTimeRange(appointment.startsAt, appointment.endsAt, timezone)}`;

  const onSubmit = async ({ reason }: CancelFormValues) => {
    if (cancel.isPending) return;
    try {
      await cancel.mutateAsync({ id: appointment.id, reason: reason || undefined });
      toast.success(`${appointment.service.name} on ${day} was cancelled.`, { title: 'Appointment cancelled' });
      onCancelled();
    } catch (error) {
      if (hasErrorCode(error, ERROR_CODES.APPOINTMENT_NOT_CANCELLABLE)) {
        // Cancelled from another tab, or the visit is already over. There is
        // nothing to retry, so close; the lists are refetched once the
        // mutation settles and show where the booking really stands.
        toast.info(`${error.message} There was nothing left to cancel.`, { title: 'Already taken care of' });
        onOpenChange(false);
        return;
      }
      // The cache has already rolled back; the dialog stays open so the user can retry or back out.
      toast.error(errorMessage(error), { title: "Couldn't cancel the appointment" });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      dismissible={!cancel.isPending}
      title="Cancel this appointment?"
      description={`${appointment.service.name} · ${when}. The time becomes available to others straight away.`}
      footer={
        <>
          {/* The safe choice takes focus, so a stray Enter cannot cancel anything. */}
          <Button data-autofocus variant="secondary" disabled={cancel.isPending} onClick={() => onOpenChange(false)}>
            Keep appointment
          </Button>
          <Button type="submit" form={formId} variant="danger" loading={cancel.isPending}>
            Cancel appointment
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit(onSubmit)} noValidate>
        <FormField
          label="Reason (optional)"
          hint="Shared with the business so they can follow up."
          error={reasonError}
        >
          <Textarea rows={3} placeholder="Let them know why you can no longer make it" {...register('reason')} />
        </FormField>
        <CharacterCount length={reasonLength} max={REASON_MAX} />
      </form>
    </Dialog>
  );
}
