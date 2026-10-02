import { isBookingComplete, missingSlots, type AppointmentDto, type BookingSlots, type ChatSessionStatus } from '@appt/shared';
import type { ChatItem, TurnMeta } from './reducer';

/**
 * The key of the one message whose actions are still live: the last item, when
 * it is the assistant's. Once the user (or a pending send) comes after it, every
 * card above is history.
 */
export function liveItemKey(items: ChatItem[]): string | null {
  const last = items[items.length - 1];
  return last?.role === 'assistant' ? last.key : null;
}

/** Everything a message's card can be rebuilt from, besides the message itself. */
export interface TurnContext {
  /** Turn payloads this tab received, by assistant message id. */
  turns: Record<string, TurnMeta>;
  /** The session's current draft and status. */
  draft: BookingSlots;
  status: ChatSessionStatus;
  /** The conversation's bookings that are still going ahead, as the transcript serves them. */
  appointments: readonly AppointmentDto[];
}

/**
 * What the UI should render with an assistant message: the turn this tab
 * received when it has one, otherwise the turn rebuilt from what the server
 * stored with the message — after a reload, or in a conversation opened from
 * the sidebar.
 *
 * Each reply is stored with its action, suggested times, the draft as it stood
 * after it and, for a booking, the appointment's id. So an earlier summary
 * shows the details it showed then, and a receipt shows its appointment as it
 * is now, from the transcript's bookings.
 *
 * Rows stored before drafts were recorded lack one. For the latest reply the
 * session's draft stands in, which is exact because only a turn changes it; an
 * older reply's draft is gone, and a summary showing today's draft against
 * yesterday's message would be wrong, so it gets no card. Rows from before
 * actions were recorded have a null action, inferred for the latest reply from
 * the same state — a completed session is a booking, a complete draft means a
 * summary was shown. That is right for everything except `needs_form`, and the
 * form is always one click away in the composer.
 */
export function turnMetaFor(item: ChatItem, live: boolean, context: TurnContext): TurnMeta | null {
  const recorded = item.id ? context.turns[item.id] : undefined;
  if (recorded) return recorded;
  if (item.role !== 'assistant') return null;

  const draft = item.draft ?? (live ? context.draft : null);
  const action = item.action ?? (live ? inferLegacyAction(context.draft, context.status) : null);
  if (!draft || !action) return null;

  return {
    action,
    missing: missingSlots(draft),
    bookingDraft: draft,
    suggestions: item.suggestions,
    appointment: action === 'booked' ? bookedBy(item, context.appointments) : undefined,
  };
}

function inferLegacyAction(draft: BookingSlots, status: ChatSessionStatus): TurnMeta['action'] {
  if (status === 'completed') return 'booked';
  return isBookingComplete(draft) ? 'confirm' : 'collect_info';
}

/**
 * The appointment a booked reply made. Older replies do not name it, but a
 * conversation closes once it books, so its one live booking is theirs. Absent
 * once cancelled: the card then shows the booked draft and claims no status.
 */
function bookedBy(item: ChatItem, appointments: readonly AppointmentDto[]): AppointmentDto | undefined {
  return item.appointmentId ? appointments.find((appointment) => appointment.id === item.appointmentId) : appointments[0];
}
