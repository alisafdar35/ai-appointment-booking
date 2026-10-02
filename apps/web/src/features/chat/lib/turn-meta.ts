import { missingSlots, type AppointmentDto } from '@appt/shared';
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
  /** The conversation's bookings that are still going ahead, as the transcript serves them. */
  appointments: readonly AppointmentDto[];
}

/**
 * What the UI should render with an assistant message: the turn this tab
 * received when it has one, otherwise the turn rebuilt from what the server
 * stored with the message (after a reload, or a conversation opened from the
 * sidebar). Each reply is stored with its own action and draft, so an earlier
 * summary shows the details it showed then; a receipt shows its appointment
 * as it is now, from the transcript's bookings.
 */
export function turnMetaFor(item: ChatItem, context: TurnContext): TurnMeta | null {
  const recorded = item.id ? context.turns[item.id] : undefined;
  if (recorded) return recorded;
  if (item.role !== 'assistant' || !item.action || !item.draft) return null;

  return {
    action: item.action,
    missing: missingSlots(item.draft),
    bookingDraft: item.draft,
    suggestions: item.suggestions,
    clarification: item.clarification,
    // Absent once cancelled: the card then shows the booked draft and claims no status.
    appointment: item.action === 'booked' ? context.appointments.find((a) => a.id === item.appointmentId) : undefined,
  };
}
