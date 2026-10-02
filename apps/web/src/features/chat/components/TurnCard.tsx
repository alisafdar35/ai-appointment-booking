import { RotateCw } from 'lucide-react';
import { isBookingComplete, type AppointmentDto, type ServiceDto } from '@appt/shared';
import { Button } from '@/components/ui/Button';
import type { ChatItem, TurnMeta } from '../lib/reducer';
import { BookedCard } from './BookedCard';
import { ConfirmationCard } from './ConfirmationCard';

/** An assistant message together with what the UI should render for it. */
export interface MessageView {
  item: ChatItem;
  /** The turn's structured payload, or null for plain history. */
  meta: TurnMeta | null;
  /** True only for the newest message while it is the assistant's: the one place actions are live. */
  live: boolean;
}

export interface TurnActions {
  onConfirm: () => void;
  onChangeDetails: () => void;
  onResend: () => void;
  onAddToCalendar: (appointment: AppointmentDto) => void;
}

interface TurnCardProps {
  view: MessageView;
  services: readonly ServiceDto[];
  timeZone: string;
  actions: TurnActions;
}

/**
 * The structured part of an assistant turn. What appears is chosen by the
 * turn's `action`, never by reading its prose.
 *
 * `collect_info` and `needs_form` have no card here: chips and the form are
 * rendered once, below the transcript, for the latest turn only.
 */
export function TurnCard({ view, services, timeZone, actions }: TurnCardProps) {
  const { meta, live } = view;
  if (!meta) return null;

  switch (meta.action) {
    case 'confirm':
      return (
        <ConfirmationCard
          draft={meta.bookingDraft}
          service={services.find((service) => service.name === meta.bookingDraft.serviceName)}
          timeZone={timeZone}
          interactive={live}
          onConfirm={actions.onConfirm}
          onChange={actions.onChangeDetails}
        />
      );

    case 'booked': {
      // Nothing to show only for a legacy booking whose draft was never complete.
      if (!meta.appointment && !isBookingComplete(meta.bookingDraft)) return null;
      return (
        <BookedCard
          appointment={meta.appointment}
          draft={meta.bookingDraft}
          service={services.find((service) => service.name === meta.bookingDraft.serviceName)}
          timeZone={timeZone}
          onAddToCalendar={actions.onAddToCalendar}
        />
      );
    }

    case 'error':
      return live ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={actions.onResend}
          leftIcon={<RotateCw className="size-3.5" aria-hidden="true" />}
        >
          Try again
        </Button>
      ) : null;

    default:
      return null;
  }
}
