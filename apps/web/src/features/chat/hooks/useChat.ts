'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  EMPTY_SLOTS,
  ERROR_CODES,
  SOCKET_EVENTS,
  type AppointmentDto,
  type AssistantTurnDto,
  type BookingSlots,
} from '@appt/shared';
import { hasErrorCode } from '@/lib/api';
import {
  applyAssistantTurn,
  queryKeys,
  refreshClosedConversation,
  useChatSessions,
  useChatTranscript,
  useCreateChatSession,
  useSendChatMessage,
  useSubmitChatDraft,
} from '@/lib/queries';
import { useRealtimeEvent } from '@/providers/RealtimeProvider';
import { mirrorTurnIntoTranscriptCache } from '../lib/cache';
import { describeSendFailure } from '../lib/failure';
import {
  NEW_SESSION_KEY,
  chatReducer,
  hasSendInFlight,
  initialChatState,
  type ChatItem,
  type SessionKey,
  type TurnMeta,
} from '../lib/reducer';

/** If a "typing" push is never followed by its turn (tab asleep, server restart), stop showing it. */
const REMOTE_TYPING_TIMEOUT_MS = 15_000;

const NO_ITEMS: ChatItem[] = [];
const NO_TURNS: Record<string, TurnMeta> = {};
const NO_APPOINTMENTS: AppointmentDto[] = [];

const newClientId = () => `local-${crypto.randomUUID()}`;

/**
 * Everything the assistant page needs from one conversation, behind one hook.
 *
 * Division of state, deliberately:
 *   - the query cache is the source of truth for the session list and for
 *     transcripts (so switching conversations is instant and shared with other
 *     components);
 *   - the reducer holds what the server has not confirmed yet (in-flight and
 *     failed messages) plus each turn's structured payload;
 *   - the booking draft is mirrored from the server on every turn, never edited
 *     here.
 *
 * Everything works over REST alone. Socket events only add live delivery from
 * the user's other tabs; a conversation never waits on one.
 */
export function useChat() {
  const queryClient = useQueryClient();
  const sessions = useChatSessions();
  const { mutateAsync: sendMessage } = useSendChatMessage();
  const { mutateAsync: submitDraft } = useSubmitChatDraft();
  const { mutateAsync: createSession } = useCreateChatSession();

  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [selected, setSelected] = useState<SessionKey | undefined>(undefined);

  // On first load resume the latest unfinished conversation; otherwise start
  // fresh. Decided once: a session list refetch must never move the user.
  useEffect(() => {
    if (selected !== undefined || sessions.isPending) return;
    const latest = sessions.data?.[0];
    setSelected(latest && latest.status === 'active' && latest.messageCount > 0 ? latest.id : NEW_SESSION_KEY);
  }, [selected, sessions.isPending, sessions.data]);

  const activeKey = selected;
  const sessionId = activeKey && activeKey !== NEW_SESSION_KEY ? activeKey : null;
  const transcript = useChatTranscript(sessionId);

  useEffect(() => {
    if (transcript.data) {
      dispatch({ type: 'hydrate', session: transcript.data.session, messages: transcript.data.messages });
    }
  }, [transcript.data]);

  const active = activeKey ? state.sessions[activeKey] : undefined;

  // Callbacks read the latest state through refs so they can stay referentially
  // stable: children memoise on them, and a send must see the current draft.
  const stateRef = useRef(state);
  const activeKeyRef = useRef(activeKey);
  useEffect(() => {
    stateRef.current = state;
    activeKeyRef.current = activeKey;
  });

  // ---- realtime: a turn produced in another tab ---------------------------
  useRealtimeEvent(SOCKET_EVENTS.ASSISTANT_TURN, (turn) => {
    applyAssistantTurn(queryClient, turn);
    mirrorTurnIntoTranscriptCache(queryClient, turn);
    dispatch({ type: 'push', turn });
  });
  useRealtimeEvent(SOCKET_EVENTS.ASSISTANT_TYPING, ({ sessionId: typingSession, typing }) => {
    dispatch({ type: 'typing', sessionId: typingSession, typing });
    // Typing starts only once the user's message is stored. When it was sent
    // from another tab, fetch it now so the dots sit under the question they
    // answer rather than under the previous reply.
    const open = stateRef.current.sessions[typingSession];
    if (typing && open && !hasSendInFlight(open)) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.transcript(typingSession) });
    }
  });

  const remoteTyping = active?.remoteTyping ?? false;
  useEffect(() => {
    if (!remoteTyping || !sessionId) return;
    const timer = setTimeout(() => dispatch({ type: 'typing', sessionId, typing: false }), REMOTE_TYPING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [remoteTyping, sessionId]);

  // ---- sending ---------------------------------------------------------------
  const absorbTurn = useCallback(
    (turn: AssistantTurnDto, sessionKey: SessionKey, clientId?: string) => {
      dispatch({ type: 'turn', sessionKey, clientId, turn });
      mirrorTurnIntoTranscriptCache(queryClient, turn);
      // The draft conversation just got a real id; keep the user in it.
      if (sessionKey === NEW_SESSION_KEY) {
        setSelected((current) => (current === NEW_SESSION_KEY ? turn.sessionId : current));
      }
    },
    [queryClient],
  );

  /** The server refused a turn because the conversation already booked, most likely from another tab. */
  const markClosed = useCallback(
    (sessionKey: SessionKey) => {
      dispatch({ type: 'closed', sessionKey });
      refreshClosedConversation(queryClient, sessionKey);
    },
    [queryClient],
  );

  const deliver = useCallback(
    async (sessionKey: SessionKey, clientId: string, content: string) => {
      try {
        const turn = await sendMessage({
          content,
          sessionId: sessionKey === NEW_SESSION_KEY ? undefined : sessionKey,
        });
        absorbTurn(turn, sessionKey, clientId);
      } catch (error) {
        const failure = describeSendFailure(error, Date.now());
        dispatch({ type: 'failed', sessionKey, clientId, failure });
        if (failure.sessionClosed) markClosed(sessionKey);
      }
    },
    [sendMessage, absorbTurn, markClosed],
  );

  /** Optimistically add a message and send it. False when a reply is still pending in that conversation. */
  const enqueue = useCallback(
    (sessionKey: SessionKey, content: string): boolean => {
      if (hasSendInFlight(stateRef.current.sessions[sessionKey])) return false;
      const clientId = newClientId();
      dispatch({ type: 'send', sessionKey, clientId, content, createdAt: new Date().toISOString() });
      void deliver(sessionKey, clientId, content);
      return true;
    },
    [deliver],
  );

  /** Returns false when nothing was sent (empty text, or a reply is still pending). */
  const send = useCallback(
    (raw: string): boolean => {
      const sessionKey = activeKeyRef.current;
      const content = raw.trim();
      if (!sessionKey || !content) return false;
      return enqueue(sessionKey, content);
    },
    [enqueue],
  );

  /**
   * Act on a failed message. Usually that is sending it again, as typed. When
   * the conversation turned out to be closed, sending here can only be refused
   * again, so the text moves into a new conversation and is sent there.
   */
  const retry = useCallback(
    (clientId: string) => {
      const sessionKey = activeKeyRef.current;
      const item = sessionKey
        ? stateRef.current.sessions[sessionKey]?.items.find((candidate) => candidate.key === clientId)
        : undefined;
      if (!sessionKey || !item || item.status !== 'failed') return;

      if (item.failure?.sessionClosed) {
        if (!enqueue(NEW_SESSION_KEY, item.content)) return;
        dispatch({ type: 'discard', sessionKey, clientId });
        setSelected(NEW_SESSION_KEY);
        return;
      }
      dispatch({ type: 'retry', sessionKey, clientId });
      void deliver(sessionKey, clientId, item.content);
    },
    [deliver, enqueue],
  );

  /** For an `error` turn: send the user's last message again. */
  const resendLast = useCallback(() => {
    const sessionKey = activeKeyRef.current;
    const items = sessionKey ? stateRef.current.sessions[sessionKey]?.items : undefined;
    const lastUser = items ? [...items].reverse().find((item) => item.role === 'user') : undefined;
    if (lastUser) send(lastUser.content);
  }, [send]);

  /**
   * Book from the structured form. Resolves with the turn so the form can react
   * to it; throws the API error so the form can map it onto its fields.
   *
   * `onSessionCreated` runs in the same update that moves the user from the
   * draft conversation into the one just created, so UI keyed by conversation
   * (the open form) can follow it instead of unmounting mid-request.
   */
  const submitForm = useCallback(
    async (slots: Partial<BookingSlots>, onSessionCreated?: (sessionId: string) => void): Promise<AssistantTurnDto> => {
      const sessionKey = activeKeyRef.current ?? NEW_SESSION_KEY;
      let id = sessionKey === NEW_SESSION_KEY ? null : sessionKey;

      if (!id) {
        // The endpoint belongs to a conversation, so a blank one gets created first.
        const created = await createSession();
        id = created.id;
        dispatch({ type: 'session_created', sessionId: id });
        setSelected(id);
        onSessionCreated?.(id);
      }

      try {
        const turn = await submitDraft({ sessionId: id, slots });
        absorbTurn(turn, id);
        return turn;
      } catch (error) {
        // Booking again here could duplicate what another tab just booked, so
        // the form closes with the conversation and the footer offers a new one.
        if (hasErrorCode(error, ERROR_CODES.SESSION_CLOSED)) markClosed(id);
        throw error;
      }
    },
    [createSession, submitDraft, absorbTurn, markClosed],
  );

  const selectSession = useCallback((key: SessionKey) => setSelected(key), []);
  const startNewConversation = useCallback(() => setSelected(NEW_SESSION_KEY), []);

  const items = active?.items ?? NO_ITEMS;
  const isSending = useMemo(() => items.some((item) => item.status === 'pending'), [items]);

  const historyState: 'loading' | 'error' | 'ready' =
    activeKey === undefined || (sessionId !== null && items.length === 0 && transcript.isPending)
      ? 'loading'
      : sessionId !== null && items.length === 0 && transcript.isError
        ? 'error'
        : 'ready';

  return {
    sessions,
    activeKey,
    sessionId,
    items,
    turns: active?.turns ?? NO_TURNS,
    /** The conversation's bookings still going ahead, from its transcript: what a booked card shows after a reload. */
    appointments: transcript.data?.appointments ?? NO_APPOINTMENTS,
    draft: active?.draft ?? EMPTY_SLOTS,
    sessionStatus: active?.status ?? 'active',
    isSending,
    isTyping: isSending || remoteTyping,
    historyState,
    reloadHistory: transcript.refetch,
    send,
    retry,
    resendLast,
    submitForm,
    selectSession,
    startNewConversation,
  };
}

export type ChatController = ReturnType<typeof useChat>;
