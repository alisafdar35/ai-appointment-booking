import { isBookingComplete, missingSlots, type AppointmentDto, type BookingSlots, type ChatSessionStatus } from '@appt/shared';
import type { ChatItem, SessionState, TurnMeta } from './reducer';

/**
 * The key of the one message whose actions are still live: the last item, when
 * it is the assistant's. Once the user (or a pending send) comes after it, every
 * card above is history.
 */
export function liveItemKey(items: ChatItem[]): string | null {
  const last = items[items.length - 1];
  return last?.role === 'assistant' ? last.key : null;
}

/**
 * What the UI should render for the latest assistant message when this tab did
 * not receive its turn — after a reload, or in a conversation opened from the
 * sidebar.
 *
 * The server records each reply's action and suggested times, so those come
 * back exactly as sent, `needs_form` included. The rest of the turn is the
 * session's current state, which is exact for the latest message because only
 * a turn changes the draft. Only the latest message is restored this way: an
 * older reply's draft is gone, and a summary card showing today's draft
 * against yesterday's message would be wrong.
 *
 * Messages stored before actions were recorded have a null action. For those
 * the action is inferred from the same state — a completed session is a
 * booking, a complete draft means a summary was shown — which is right for
 * everything except `needs_form`, and the form is always one click away in
 * the composer.
 */
export function restoreTurnMeta(
  item: Pick<ChatItem, 'action' | 'suggestions'>,
  session: Pick<SessionState, 'draft' | 'status'>,
  bookedAppointment?: AppointmentDto,
): TurnMeta {
  const { draft, status } = session;
  const action = item.action ?? inferLegacyAction(draft, status);
  return {
    action,
    missing: missingSlots(draft),
    bookingDraft: draft,
    suggestions: item.suggestions,
    appointment: action === 'booked' ? bookedAppointment : undefined,
  };
}

function inferLegacyAction(draft: BookingSlots, status: ChatSessionStatus): TurnMeta['action'] {
  if (status === 'completed') return 'booked';
  return isBookingComplete(draft) ? 'confirm' : 'collect_info';
}

/**
 * The booking a completed conversation produced, found by the appointment's
 * back-reference to its session. The transcript records that a booking was
 * made, not what it was, so the card is rebuilt from the appointments cache.
 */
export function findBookedAppointment(
  sessionId: string | null,
  appointments: readonly AppointmentDto[] | undefined,
): AppointmentDto | undefined {
  if (!sessionId) return undefined;
  return appointments?.find((appointment) => appointment.chatSessionId === sessionId && appointment.status !== 'cancelled');
}
