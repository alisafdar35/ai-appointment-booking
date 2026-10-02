import type { QueryClient } from '@tanstack/react-query';
import type { AssistantTurnDto } from '@appt/shared';
import type { ChatTranscript } from '@/lib/api';
import { queryKeys } from '@/lib/queries';

/**
 * Write a finished turn into the transcript cache so reopening the conversation
 * from the sidebar is instant and already correct, instead of showing the
 * previous state until a refetch lands. Both halves are written: the turn
 * carries the user's message as stored, real id included.
 *
 * Idempotent by message id, because the socket delivers the sender's own turn
 * back to it in addition to the HTTP response.
 */
export function mirrorTurnIntoTranscriptCache(queryClient: QueryClient, turn: AssistantTurnDto): void {
  queryClient.setQueryData<ChatTranscript>(queryKeys.chat.transcript(turn.sessionId), (transcript) => {
    if (!transcript) return transcript;
    const known = new Set(transcript.messages.map((message) => message.id));
    const added = [turn.userMessage, turn.message].filter((message) => !known.has(message.id));
    return {
      session: {
        ...transcript.session,
        bookingDraft: turn.bookingDraft,
        status: turn.action === 'booked' ? 'completed' : transcript.session.status,
      },
      messages: added.length ? [...transcript.messages, ...added] : transcript.messages,
    };
  });
}
