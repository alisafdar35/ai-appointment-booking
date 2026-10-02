import {
  EMPTY_SLOTS,
  type AiEngine,
  type AssistantAction,
  type AssistantTurnDto,
  type BookingSlots,
  type BookingSuggestion,
  type ChatMessageDto,
  type ChatSessionDto,
  type ChatSessionStatus,
} from '@appt/shared';

/**
 * Conversation state, as a pure reducer.
 *
 * The query cache owns what the server has told us (sessions, transcripts);
 * this reducer owns what the server has NOT yet confirmed: a message that is
 * still in flight, one that failed and can be retried, and the full payload of
 * each assistant turn this tab received (the transcript records a reply's
 * action and suggestions, but not the draft or appointment that went with it).
 * Keeping it pure — no clocks, no ids, no network — is what makes the awkward
 * parts testable: optimistic writes, reconciling with the server's version of
 * the same message, and the socket echoing our own turn back to us.
 *
 * State is a map keyed by session so a reply that arrives after the user has
 * switched conversations still lands in the right one.
 */

/** The key for a conversation that has no server-side session yet. */
export const NEW_SESSION_KEY = 'new';
export type SessionKey = string;

export type ItemStatus = 'sent' | 'pending' | 'failed';

export interface SendFailure {
  message: string;
  /** Present for RATE_LIMITED: how long the server asked us to wait. */
  retryAfterSeconds?: number;
  /**
   * The conversation had already booked (SESSION_CLOSED), so sending again here
   * can never work; the way forward is the same text in a new conversation.
   */
  sessionClosed?: boolean;
  /** Epoch ms when it failed, so a countdown can be computed without a clock here. */
  failedAt: number;
}

export interface ChatItem {
  /** Stable across the optimistic -> confirmed handover, so React never remounts the bubble. */
  key: string;
  /** The server's message id; null for a user message the server has not acknowledged. */
  id: string | null;
  role: 'user' | 'assistant';
  content: string;
  engine: AiEngine | null;
  /** What the server decided the UI should offer with this reply. Null for user messages and legacy rows. */
  action: AssistantAction | null;
  suggestions?: BookingSuggestion[];
  createdAt: string;
  status: ItemStatus;
  failure?: SendFailure;
}

/** What the UI renders from an assistant turn. */
export type TurnMeta = Pick<AssistantTurnDto, 'action' | 'missing' | 'suggestions' | 'appointment' | 'bookingDraft'>;

export interface SessionState {
  items: ChatItem[];
  /** Server-authoritative; the client mirrors it and never edits it. */
  draft: BookingSlots;
  status: ChatSessionStatus;
  /** Turn payloads by assistant message id. */
  turns: Record<string, TurnMeta>;
  /** The newest assistant message we know of, used to spot a stale transcript. */
  lastTurnId: string | null;
  hydrated: boolean;
  remoteTyping: boolean;
}

export interface ChatState {
  sessions: Record<SessionKey, SessionState>;
}

export type ChatAction =
  | { type: 'send'; sessionKey: SessionKey; clientId: string; content: string; createdAt: string }
  | { type: 'retry'; sessionKey: SessionKey; clientId: string }
  | { type: 'failed'; sessionKey: SessionKey; clientId: string; failure: SendFailure }
  /** Remove a local message the server never stored (one moved to a new conversation). */
  | { type: 'discard'; sessionKey: SessionKey; clientId: string }
  /** The server's answer to a request this tab made. `clientId` is the message it answers, when there is one (the form has none). */
  | { type: 'turn'; sessionKey: SessionKey; clientId?: string; turn: AssistantTurnDto }
  /** A turn pushed over the socket. Ignored for conversations this tab has not opened. */
  | { type: 'push'; turn: AssistantTurnDto }
  /** A session was created before any message (the form path); the draft conversation adopts its id. */
  | { type: 'session_created'; sessionId: string }
  /** The server refused a turn because the conversation already booked, possibly from another tab. */
  | { type: 'closed'; sessionKey: SessionKey }
  | { type: 'hydrate'; session: ChatSessionDto; messages: ChatMessageDto[] }
  | { type: 'typing'; sessionId: string; typing: boolean };

export const initialChatState: ChatState = { sessions: {} };

export function emptySession(): SessionState {
  return {
    items: [],
    draft: EMPTY_SLOTS,
    status: 'active',
    turns: {},
    lastTurnId: null,
    hydrated: false,
    remoteTyping: false,
  };
}

/** The transcript never carries system or tool rows into the UI. */
type Speaker = 'user' | 'assistant';

const serverItem = (message: ChatMessageDto, role: Speaker): ChatItem => ({
  key: `message-${message.id}`,
  id: message.id,
  role,
  content: message.content,
  engine: message.engine,
  action: message.action,
  suggestions: message.suggestions,
  createdAt: message.createdAt,
  status: 'sent',
});

/** The server's fields for a message this tab already shows under its own key. */
const confirmedBy = (item: ChatItem, message: ChatMessageDto): ChatItem => ({
  ...item,
  id: message.id,
  content: message.content,
  engine: message.engine,
  action: message.action,
  suggestions: message.suggestions,
  createdAt: message.createdAt,
});

/**
 * A user message the server has not acknowledged yet. Until its turn returns
 * the stored id, nothing can tell it apart from other user messages in the
 * transcript — and matching on text would pair two identical "yes" replies.
 */
const isAwaitingId = (item: ChatItem) => item.role === 'user' && item.id === null && item.status === 'pending';

export const hasSendInFlight = (session: SessionState | undefined): boolean =>
  session?.items.some(isAwaitingId) ?? false;

const withSession = (state: ChatState, key: SessionKey, session: SessionState): ChatState => ({
  sessions: { ...state.sessions, [key]: session },
});

/** Move the draft conversation's state under its newly created server id. */
function adoptSessionId(state: ChatState, sessionId: string): ChatState {
  const { [NEW_SESSION_KEY]: adopted, ...rest } = state.sessions;
  return adopted ? { sessions: { ...rest, [sessionId]: adopted } } : state;
}

const updateItem = (items: ChatItem[], clientId: string, change: (item: ChatItem) => ChatItem): ChatItem[] =>
  items.map((item) => (item.key === clientId ? change(item) : item));

/**
 * Place both halves of a turn. Our own message is matched by the client id
 * that sent it and takes the server's id; anyone else's (another tab, or the
 * form's synthetic "Book X on D at T.") is added unless already present. Every
 * check is by id, so the socket echo of a turn is a no-op.
 */
function placeTurn(items: ChatItem[], turn: AssistantTurnDto, clientId: string | undefined): ChatItem[] {
  const { userMessage, message } = turn;
  let placed = items;

  if (clientId) {
    placed = updateItem(
      placed.filter((item) => item.key === clientId || item.id !== userMessage.id),
      clientId,
      (item) => ({ ...confirmedBy(item, userMessage), status: 'sent', failure: undefined }),
    );
  } else if (!placed.some((item) => item.id === userMessage.id || item.id === message.id)) {
    placed = [...placed, serverItem(userMessage, 'user')];
  }

  return placed.some((item) => item.id === message.id) ? placed : [...placed, serverItem(message, 'assistant')];
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'send': {
      const session = state.sessions[action.sessionKey] ?? emptySession();
      const item: ChatItem = {
        key: action.clientId,
        id: null,
        role: 'user',
        content: action.content,
        engine: null,
        action: null,
        createdAt: action.createdAt,
        status: 'pending',
      };
      return withSession(state, action.sessionKey, { ...session, items: [...session.items, item] });
    }

    case 'retry': {
      const session = state.sessions[action.sessionKey];
      if (!session) return state;
      const items = updateItem(session.items, action.clientId, (item) => ({
        ...item,
        status: 'pending',
        failure: undefined,
      }));
      return withSession(state, action.sessionKey, { ...session, items });
    }

    case 'failed': {
      const session = state.sessions[action.sessionKey];
      if (!session) return state;
      const items = updateItem(session.items, action.clientId, (item) => ({
        ...item,
        status: 'failed',
        failure: action.failure,
      }));
      return withSession(state, action.sessionKey, { ...session, items });
    }

    case 'discard': {
      const session = state.sessions[action.sessionKey];
      if (!session) return state;
      const items = session.items.filter((item) => item.key !== action.clientId);
      return withSession(state, action.sessionKey, { ...session, items });
    }

    case 'turn': {
      const { turn, clientId } = action;
      const session = state.sessions[action.sessionKey] ?? emptySession();
      const next: SessionState = {
        ...session,
        items: placeTurn(session.items, turn, clientId),
        draft: turn.bookingDraft,
        status: turn.action === 'booked' ? 'completed' : session.status,
        turns: {
          ...session.turns,
          [turn.message.id]: {
            action: turn.action,
            missing: turn.missing,
            suggestions: turn.suggestions,
            appointment: turn.appointment,
            bookingDraft: turn.bookingDraft,
          },
        },
        lastTurnId: turn.message.id,
        remoteTyping: false,
      };

      const target = action.sessionKey === NEW_SESSION_KEY ? turn.sessionId : action.sessionKey;
      const moved = target === action.sessionKey ? state : adoptSessionId(state, target);
      return withSession(moved, target, next);
    }

    case 'push': {
      const session = state.sessions[action.turn.sessionId];
      // Nothing to attach to for a conversation this tab never opened; the cache
      // mirror and the sidebar refetch cover it. While this tab has a send in
      // flight there, the push is almost always the echo of that send, and its
      // user message cannot be paired with our bubble until our own response
      // names the id. That response, and the refetch after it, deliver it all.
      if (!session || hasSendInFlight(session)) return state;
      return chatReducer(state, { type: 'turn', sessionKey: action.turn.sessionId, turn: action.turn });
    }

    case 'session_created':
      return adoptSessionId(state, action.sessionId);

    case 'closed': {
      const session = state.sessions[action.sessionKey];
      if (!session) return state;
      return withSession(state, action.sessionKey, { ...session, status: 'completed', remoteTyping: false });
    }

    case 'hydrate':
      return withSession(state, action.session.id, hydrateSession(state.sessions[action.session.id], action));

    case 'typing': {
      const session = state.sessions[action.sessionId];
      if (!session || session.remoteTyping === action.typing) return state;
      return withSession(state, action.sessionId, { ...session, remoteTyping: action.typing });
    }
  }
}

/**
 * Reconcile the server's transcript with what this tab already knows.
 *
 * Server order wins, and messages are matched by id only. Local items are kept
 * when the server cannot have them yet: a message still in flight, one that
 * failed, or a turn the (possibly stale) transcript response predates.
 *
 * While a send is in flight the transcript is read only up to the first user
 * message this tab has never seen. That message is very likely the one in
 * flight, already stored but not yet acknowledged; showing it would double the
 * bubble. The turn response names its id, and the refetch that follows every
 * turn brings in whatever was held back.
 */
function hydrateSession(
  current: SessionState | undefined,
  { session, messages }: { session: ChatSessionDto; messages: ChatMessageDto[] },
): SessionState {
  const local = current ?? emptySession();
  const awaiting = hasSendInFlight(local);
  const claimed = new Set<string>();

  const confirmed: ChatItem[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const twin = local.items.find((item) => item.id === message.id);

    if (!twin) {
      if (awaiting && message.role === 'user') break;
      confirmed.push(serverItem(message, message.role));
      continue;
    }
    claimed.add(twin.key);
    // The status is deliberately kept: a "failed" message stays retryable. The
    // turn, not the transcript, is what completes a send.
    confirmed.push(confirmedBy(twin, message));
  }

  // Items the server does not know yet keep their place after whatever preceded
  // them locally. Appending them at the end would put our own message below the
  // reply to it whenever the cache already holds the reply but not the message.
  // The exception is a message still in flight: the transcript was read only up
  // to where its stored copy would be, so everything confirmed precedes it.
  const items = [...confirmed];
  local.items.forEach((item, index) => {
    if (claimed.has(item.key)) return;
    if (isAwaitingId(item)) {
      items.push(item);
      return;
    }
    const previous = local.items[index - 1];
    const after = previous ? items.findIndex((candidate) => candidate.key === previous.key) : -1;
    items.splice(after + 1, 0, item);
  });

  const transcriptIsStale =
    local.lastTurnId !== null && !messages.some((message) => message.id === local.lastTurnId);

  return {
    ...local,
    items,
    // A stale transcript must not roll the draft back to before the latest turn.
    draft: transcriptIsStale ? local.draft : session.bookingDraft,
    // ...nor reopen a conversation this tab has seen close.
    status: transcriptIsStale || local.status === 'completed' ? local.status : session.status,
    hydrated: true,
  };
}
