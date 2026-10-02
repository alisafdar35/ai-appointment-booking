-- =============================================================================
-- 002_indexes.sql — indexing strategy
--
-- Every index below exists for a query this application actually runs; the
-- driving query is named above each one. Indexes are not free (write
-- amplification, planner time, disk), so "index every column" is not a strategy.
--
-- Two Postgres specifics that shape this file:
--   1. Postgres does NOT automatically index foreign keys (MySQL/InnoDB does).
--      An unindexed FK makes ON DELETE CASCADE do a sequential scan of the child
--      table per deleted parent row. Each FK used for joins or cascades is
--      therefore indexed explicitly below.
--   2. UNIQUE constraints already create a btree index. Those are deliberately
--      NOT duplicated here — the constraint is the index.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- Login:  WHERE business_id = $1 AND email = $2
--   -> served by UNIQUE (business_id, email). No additional index.
-- Tenant user list: WHERE business_id = $1 ORDER BY created_at DESC
CREATE INDEX users_business_created_idx ON users (business_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- refresh_tokens
-- ---------------------------------------------------------------------------
-- Rotation lookup: WHERE token_hash = $1
--   -> served by UNIQUE (token_hash).
-- Revoke-all-on-theft / logout-everywhere: WHERE user_id = $1
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
-- Scheduled cleanup: DELETE WHERE expires_at < now().
-- Partial: rows already revoked are deleted by the same sweep, and the index
-- only needs to find tokens that are still live.
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- services
-- ---------------------------------------------------------------------------
-- Booking form + AI service catalogue: WHERE business_id = $1 AND is_active
-- Partial, because inactive services are never listed and the predicate is
-- almost always true -> a small, hot index.
CREATE INDEX services_business_active_idx ON services (business_id, name)
  WHERE is_active;

-- ---------------------------------------------------------------------------
-- appointments  (the read-heaviest table)
-- ---------------------------------------------------------------------------
-- "My appointments", the primary dashboard query:
--   WHERE business_id = $1 AND user_id = $2 ORDER BY starts_at DESC
-- Column order is equality-first, then the range/sort column, so the index
-- satisfies both the filter and the ORDER BY with no sort step.
CREATE INDEX appointments_user_starts_idx
  ON appointments (business_id, user_id, starts_at DESC);

-- Business day/week calendar:
--   WHERE business_id = $1 AND starts_at >= $2 AND starts_at < $3
CREATE INDEX appointments_business_starts_idx
  ON appointments (business_id, starts_at);

-- Upcoming-only views and reminder sweeps. Partial on live statuses keeps this
-- index proportional to the active book, not to all history ever recorded.
CREATE INDEX appointments_upcoming_idx
  ON appointments (business_id, starts_at)
  WHERE status IN ('pending', 'confirmed');

-- Availability / overlap probing:
--   WHERE business_id = $1 AND service_id = $2 AND slot && tstzrange($3, $4)
--   -> already served by the GIST index backing the appointments_no_overlap
--      EXCLUDE constraint. Not duplicated.

-- FK indexes needed for cascade/join performance (see note 1 above).
CREATE INDEX appointments_service_idx      ON appointments (service_id);
CREATE INDEX appointments_chat_session_idx ON appointments (chat_session_id)
  WHERE chat_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- chat_sessions
-- ---------------------------------------------------------------------------
-- Session sidebar: WHERE business_id = $1 AND user_id = $2
--                  ORDER BY last_message_at DESC NULLS LAST
-- NULLS LAST is declared on the index so the planner can read it in order
-- instead of sorting; it must match the ORDER BY exactly to be usable.
CREATE INDEX chat_sessions_user_recent_idx
  ON chat_sessions (business_id, user_id, last_message_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- chat_messages  (the write-heaviest table)
-- ---------------------------------------------------------------------------
-- Transcript load and pagination: WHERE session_id = $1 ORDER BY id
-- bigserial id is monotonic per insert, so (session_id, id) gives a stable
-- total order and keyset pagination without a timestamp tiebreaker.
CREATE INDEX chat_messages_session_id_idx ON chat_messages (session_id, id);

-- ---------------------------------------------------------------------------
-- ai_interaction_logs
-- ---------------------------------------------------------------------------
-- Debugging a single conversation: WHERE session_id = $1 ORDER BY created_at
CREATE INDEX ai_logs_session_idx ON ai_interaction_logs (session_id, created_at)
  WHERE session_id IS NOT NULL;
-- Reliability dashboard: failures by provider over a window.
-- Partial on outcome <> 'ok' because >95% of rows are successes and only the
-- failures are ever queried this way.
CREATE INDEX ai_logs_failures_idx ON ai_interaction_logs (provider, created_at DESC)
  WHERE outcome <> 'ok';
-- Cost/latency rollups: WHERE created_at >= $1
CREATE INDEX ai_logs_created_idx ON ai_interaction_logs (created_at DESC);
