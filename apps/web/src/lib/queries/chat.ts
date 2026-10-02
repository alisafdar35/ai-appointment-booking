import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AssistantTurnDto, SendMessageInput } from '@appt/shared';
import { chatApi, type SubmitDraftRequest } from '@/lib/api';
import { upsertAppointmentInCaches } from './appointment-cache';
import { queryKeys } from './keys';

/** The conversation list. Sorted by the server, most recently active first. */
export function useChatSessions() {
  return useQuery({
    queryKey: queryKeys.chat.sessions(),
    queryFn: ({ signal }) => chatApi.listSessions(signal),
  });
}

/** One conversation's history. Pass null while no conversation is selected. */
export function useChatTranscript(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.chat.transcript(sessionId ?? ''),
    queryFn: ({ signal }) => chatApi.getTranscript(sessionId!, signal),
    enabled: Boolean(sessionId),
  });
}

/**
 * Reflect a finished assistant turn in the caches: a booking made through chat
 * appears on the appointments dashboard, and the sidebar and transcript
 * (title, message count, new messages) are refreshed from the server.
 */
export function applyAssistantTurn(queryClient: QueryClient, turn: AssistantTurnDto): void {
  if (turn.appointment) upsertAppointmentInCaches(queryClient, turn.appointment);
  void queryClient.invalidateQueries({ queryKey: queryKeys.chat.sessions() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.chat.transcript(turn.sessionId) });
}

/**
 * Catch up on a conversation that closed without this tab seeing it — booked
 * from another tab while the socket was down. The transcript brings in the
 * booking reply and the appointment lists bring in what was booked, so the
 * conversation can show its booked card.
 */
export function refreshClosedConversation(queryClient: QueryClient, sessionId: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.chat.transcript(sessionId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.chat.sessions() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.appointments.lists() });
}

export function useCreateChatSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => chatApi.createSession(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chat.sessions() }),
  });
}

/** Send a typed message. Resolves with the whole assistant turn (reply, action, draft, appointment). */
export function useSendChatMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SendMessageInput) => chatApi.sendMessage(input),
    onSuccess: (turn) => applyAssistantTurn(queryClient, turn),
  });
}

/** Complete a booking from the structured fallback card instead of typing. */
export function useSubmitChatDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitDraftRequest) => chatApi.submitDraft(input),
    onSuccess: (turn) => applyAssistantTurn(queryClient, turn),
  });
}
