import type { z } from 'zod';
import type {
  AssistantTurnDto,
  ChatMessageDto,
  ChatSessionDto,
  SendMessageInput,
  submitDraftSchema,
} from '@appt/shared';
import { apiRequest } from './client';

export type SubmitDraftRequest = z.input<typeof submitDraftSchema>;

export interface ChatTranscript {
  session: ChatSessionDto;
  messages: ChatMessageDto[];
}

export const chatApi = {
  /** The conversation sidebar, most recently active first. */
  listSessions: async (signal?: AbortSignal): Promise<ChatSessionDto[]> =>
    (await apiRequest<{ sessions: ChatSessionDto[] }>('/chat/sessions', { signal })).sessions,

  createSession: async (): Promise<ChatSessionDto> =>
    (await apiRequest<{ session: ChatSessionDto }>('/chat/sessions', { method: 'POST' })).session,

  getTranscript: (sessionId: string, signal?: AbortSignal): Promise<ChatTranscript> =>
    apiRequest<ChatTranscript>(`/chat/sessions/${encodeURIComponent(sessionId)}`, { signal }),

  /**
   * Send one user message and receive the assistant's whole turn: reply text,
   * the UI `action` to render, the server-authoritative draft, and the
   * appointment when one was booked. Omit `sessionId` on the first message.
   */
  sendMessage: (input: SendMessageInput): Promise<AssistantTurnDto> =>
    apiRequest<AssistantTurnDto>('/chat/messages', { method: 'POST', body: input }),

  /**
   * The structured-form escape hatch: same booking rules, no prose. A booking
   * rule saying no (time taken, outside hours, in the past) comes back as a
   * non-booked turn, not as an HTTP error; errors are validation, a closed
   * conversation, or transport.
   */
  submitDraft: (input: SubmitDraftRequest): Promise<AssistantTurnDto> =>
    apiRequest<AssistantTurnDto>('/chat/draft', { method: 'POST', body: input }),
};
