import type {
  AiEngine,
  AssistantAction,
  BookingSlots,
  BookingSuggestion,
  ChatMessageDto,
  ChatMessageRole,
  ChatSessionDto,
  ChatSessionStatus,
  ClarificationDto,
  RequiredSlot,
} from '@appt/shared';
import { EMPTY_SLOTS } from '@appt/shared';
import { pool, type Queryable } from '../../db/pool.js';

interface SessionRow {
  id: string;
  title: string;
  status: ChatSessionStatus;
  booking_draft: Partial<BookingSlots>;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
}

const toSessionDto = (row: SessionRow): ChatSessionDto => ({
  id: row.id,
  title: row.title,
  status: row.status,
  // A new session's draft is the column default '{}': fill in the empty slots.
  bookingDraft: { ...EMPTY_SLOTS, ...(row.booking_draft ?? {}) },
  messageCount: row.message_count,
  lastMessageAt: row.last_message_at,
  createdAt: row.created_at,
});

const SESSION_SELECT = `
  SELECT id, title, status, booking_draft, message_count, last_message_at, created_at
  FROM chat_sessions
`;

export async function listSessions(businessId: string, userId: string, limit = 30): Promise<ChatSessionDto[]> {
  const { rows } = await pool.query<SessionRow>(
    `${SESSION_SELECT}
     WHERE business_id = $1 AND user_id = $2
     ORDER BY last_message_at DESC NULLS LAST, created_at DESC
     LIMIT $3`,
    [businessId, userId, limit],
  );
  return rows.map(toSessionDto);
}

/**
 * Fetch a session, scoped to its owner.
 *
 * business_id AND user_id are both in the WHERE clause, so a user cannot read
 * another user's conversation by passing its id — the query simply returns
 * nothing and the caller raises a 404. Authorisation is part of the query
 * rather than a separate check that could be forgotten.
 */
export async function findSession(
  businessId: string,
  userId: string,
  sessionId: string,
  client: Queryable = pool,
): Promise<ChatSessionDto | null> {
  const { rows } = await client.query<SessionRow>(
    `${SESSION_SELECT} WHERE business_id = $1 AND user_id = $2 AND id = $3`,
    [businessId, userId, sessionId],
  );
  return rows[0] ? toSessionDto(rows[0]) : null;
}

export async function createSession(
  client: Queryable,
  input: { businessId: string; userId: string; title: string },
): Promise<ChatSessionDto> {
  const { rows } = await client.query<SessionRow>(
    `INSERT INTO chat_sessions (business_id, user_id, title)
     VALUES ($1, $2, $3)
     RETURNING id, title, status, booking_draft, message_count, last_message_at, created_at`,
    [input.businessId, input.userId, input.title.slice(0, 200)],
  );
  return toSessionDto(rows[0]!);
}

/**
 * What the UI was told to do with an assistant message, stored beside it.
 *
 * The draft on the session only describes the conversation's latest state; it
 * cannot say that message 12 carried a confirmation card or which times were
 * offered after a clash. Keeping the turn's outcome on the message is what lets
 * a reloaded transcript render the same controls the live one did, each from
 * its own draft and booking. `missing` is kept for debugging and replay; the
 * client derives it from the draft.
 */
export interface MessageMeta {
  action: AssistantAction;
  suggestions?: BookingSuggestion[];
  clarification?: ClarificationDto;
  missing: RequiredSlot[];
  draft: BookingSlots;
  appointmentId?: string;
}

interface MessageRow {
  id: number;
  role: ChatMessageRole;
  content: string;
  engine: AiEngine | null;
  meta: MessageMeta | null;
  created_at: string;
}

const toMessageDto = (row: MessageRow): ChatMessageDto => ({
  id: String(row.id),
  role: row.role,
  content: row.content,
  engine: row.engine,
  action: row.meta?.action ?? null,
  ...(row.meta?.suggestions?.length ? { suggestions: row.meta.suggestions } : {}),
  ...(row.meta?.clarification ? { clarification: row.meta.clarification } : {}),
  ...(row.meta ? { draft: row.meta.draft } : {}),
  ...(row.meta?.appointmentId ? { appointmentId: row.meta.appointmentId } : {}),
  createdAt: row.created_at,
});

/**
 * Append a message and update the session counters in one statement.
 *
 * A CTE rather than two queries: message_count and last_message_at must never
 * disagree with the rows in chat_messages, and doing both in one round trip
 * keeps them consistent without a transaction block.
 */
export async function appendMessage(
  client: Queryable,
  input: {
    sessionId: string;
    role: ChatMessageRole;
    content: string;
    engine?: AiEngine | null;
    toolCalls?: unknown;
    meta?: MessageMeta;
  },
): Promise<ChatMessageDto> {
  const { rows } = await client.query<MessageRow>(
    `WITH inserted AS (
       INSERT INTO chat_messages (session_id, role, content, engine, tool_calls, meta)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, role, content, engine, meta, created_at, session_id
     ), bumped AS (
       UPDATE chat_sessions
       SET message_count = message_count + 1, last_message_at = now()
       WHERE id = (SELECT session_id FROM inserted)
     )
     SELECT id, role, content, engine, meta, created_at FROM inserted`,
    [
      input.sessionId,
      input.role,
      input.content.slice(0, 8000),
      input.engine ?? null,
      input.toolCalls ? JSON.stringify(input.toolCalls) : null,
      input.meta ? JSON.stringify(input.meta) : null,
    ],
  );
  return toMessageDto(rows[0]!);
}

export async function listMessages(
  businessId: string,
  userId: string,
  sessionId: string,
  limit = 200,
): Promise<ChatMessageDto[]> {
  // The join re-asserts ownership, so a transcript cannot be read by id alone.
  const { rows } = await pool.query<MessageRow>(
    // The newest `limit` messages, oldest first: a long conversation must lose
    // its beginning, not its end.
    `SELECT id, role, content, engine, meta, created_at FROM (
       SELECT m.id, m.role, m.content, m.engine, m.meta, m.created_at
       FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
       WHERE s.business_id = $1 AND s.user_id = $2 AND m.session_id = $3
         AND m.role <> 'system'
       ORDER BY m.id DESC
       LIMIT $4
     ) newest
     ORDER BY id ASC`,
    [businessId, userId, sessionId, limit],
  );
  return rows.map(toMessageDto);
}

/**
 * The last N turns, for the model's context window.
 *
 * Fetched newest-first with a LIMIT and then reversed, so the query reads the
 * tail of the index instead of scanning the whole conversation. The cap is what
 * keeps prompt size — and therefore cost and latency — flat as a conversation
 * grows, rather than creeping up with every message.
 */
export async function recentTurns(
  sessionId: string,
  limit: number,
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const { rows } = await pool.query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT role, content FROM (
       SELECT role, content, id FROM chat_messages
       WHERE session_id = $1 AND role IN ('user', 'assistant')
       ORDER BY id DESC
       LIMIT $2
     ) recent
     ORDER BY id ASC`,
    [sessionId, limit],
  );
  return rows;
}

export async function updateDraft(
  client: Queryable,
  sessionId: string,
  draft: BookingSlots,
): Promise<void> {
  await client.query(`UPDATE chat_sessions SET booking_draft = $2 WHERE id = $1`, [
    sessionId,
    JSON.stringify(draft),
  ]);
}

/** Status is not set here: a session is completed only by the booking that closes it (bookInSession). */
export async function updateSessionTitle(client: Queryable, sessionId: string, title: string): Promise<void> {
  await client.query(`UPDATE chat_sessions SET title = $2 WHERE id = $1`, [sessionId, title.slice(0, 200)]);
}

/**
 * What the last few assistant turns told the UI, newest first, and whether the
 * structured form was ever offered in this conversation. Drives the "offer the
 * form" heuristic in the chat service, which looks for turns that made no
 * progress rather than counting messages.
 */
export async function recentOutcomes(
  sessionId: string,
  limit: number,
): Promise<{ recent: (MessageMeta | null)[]; formOffered: boolean }> {
  const { rows } = await pool.query<{ recent: (MessageMeta | null)[]; form_offered: boolean }>(
    `SELECT
       COALESCE((
         SELECT json_agg(r.meta ORDER BY r.id DESC)
         FROM (
           SELECT id, meta FROM chat_messages
           WHERE session_id = $1 AND role = 'assistant'
           ORDER BY id DESC
           LIMIT $2
         ) r
       ), '[]'::json) AS recent,
       EXISTS (
         SELECT 1 FROM chat_messages
         WHERE session_id = $1 AND role = 'assistant' AND meta->>'action' = 'needs_form'
       ) AS form_offered`,
    [sessionId, limit],
  );
  return { recent: rows[0]?.recent ?? [], formOffered: rows[0]?.form_offered ?? false };
}

export async function findBusinessContext(businessId: string): Promise<{
  name: string;
  timezone: string;
  opensAt: string;
  closesAt: string;
  /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
  openDays: number[];
} | null> {
  const { rows } = await pool.query<{
    name: string;
    timezone: string;
    opens_at: string;
    closes_at: string;
    open_days: number[];
  }>(
    `SELECT name, timezone, to_char(opens_at, 'HH24:MI') AS opens_at,
            to_char(closes_at, 'HH24:MI') AS closes_at, open_days
     FROM businesses WHERE id = $1`,
    [businessId],
  );
  const row = rows[0];
  return row
    ? { name: row.name, timezone: row.timezone, opensAt: row.opens_at, closesAt: row.closes_at, openDays: row.open_days }
    : null;
}

/**
 * The name the assistant addresses the user by.
 *
 * Read here rather than carried in the access token: the token holds an email,
 * and an email's local part ("m.reed42") is neither a name nor something worth
 * sending to a third-party model.
 */
export async function findFirstName(businessId: string, userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ first_name: string }>(
    `SELECT split_part(btrim(full_name), ' ', 1) AS first_name
     FROM users WHERE business_id = $1 AND id = $2`,
    [businessId, userId],
  );
  return rows[0]?.first_name ?? null;
}
