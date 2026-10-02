-- =============================================================================
-- 002_indexes.sql — indexing strategy
--
-- Every index below exists for a query this application actually runs; the
-- driving query is named above each one. Indexes are not free (write
-- amplification, planner time, disk), so "index every column" is not a strategy.
--
-- Two Postgres specifics shape this file:
--   1. Postgres does NOT index foreign keys automatically. An unindexed FK makes
--      ON DELETE CASCADE scan the child table per deleted parent row, so FKs
--      used for joins or cascades are indexed explicitly.
--   2. UNIQUE / PRIMARY KEY / EXCLUDE constraints already create an index.
--      Those are not duplicated here — the constraint is the index.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- Login: the sign-in form sends no tenant, so findUserForLogin filters on
-- email alone (slug optional, via a join). UNIQUE (business_id, email) cannot
-- seek on its second column; this serves both forms.
CREATE INDEX users_email_idx ON users (email);
-- Tenant user list: WHERE business_id = $1 ORDER BY created_at DESC
CREATE INDEX users_business_created_idx ON users (business_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- refresh_tokens
-- ---------------------------------------------------------------------------
-- Rotation lookup: WHERE token_hash = $1  -> served by UNIQUE (token_hash).
-- Revoke-all-on-theft / logout-everywhere: WHERE user_id = $1
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
-- Scheduled cleanup: DELETE WHERE expires_at < now(). Partial: revoked rows go
-- in the same sweep, so the index only needs to find tokens still live.
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- services
-- ---------------------------------------------------------------------------
-- Booking form + AI service catalogue: WHERE business_id = $1 AND is_active
-- Partial: inactive services are never listed -> a small, hot index.
CREATE INDEX services_business_active_idx ON services (business_id, name)
  WHERE is_active;

-- ---------------------------------------------------------------------------
-- appointments  (the read-heaviest table)
-- ---------------------------------------------------------------------------
-- "My appointments": WHERE business_id = $1 AND user_id = $2 ORDER BY starts_at DESC
-- Equality columns first, then the sort column: no sort step.
CREATE INDEX appointments_user_starts_idx
  ON appointments (business_id, user_id, starts_at DESC);

-- Business calendar: WHERE business_id = $1 AND starts_at >= $2 AND starts_at < $3
CREATE INDEX appointments_business_starts_idx
  ON appointments (business_id, starts_at);

-- Upcoming-only views and reminder sweeps. Partial on live statuses keeps it
-- proportional to the active book, not to all history.
CREATE INDEX appointments_upcoming_idx
  ON appointments (business_id, starts_at)
  WHERE status IN ('pending', 'confirmed');

-- Availability / overlap probing (slot && tstzrange($3, $4)) is served by the
-- GIST indexes behind the two EXCLUDE constraints. Not duplicated.

-- FK indexes for cascade/join performance (note 1).
CREATE INDEX appointments_service_idx      ON appointments (service_id);
CREATE INDEX appointments_chat_session_idx ON appointments (chat_session_id)
  WHERE chat_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- chat_sessions
-- ---------------------------------------------------------------------------
-- Session sidebar: WHERE business_id = $1 AND user_id = $2
--                  ORDER BY last_message_at DESC NULLS LAST
-- NULLS LAST must match the ORDER BY for the planner to read the index in order.
CREATE INDEX chat_sessions_user_recent_idx
  ON chat_sessions (business_id, user_id, last_message_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- chat_messages  (the write-heaviest table)
-- ---------------------------------------------------------------------------
-- Transcript load and pagination: WHERE session_id = $1 ORDER BY id
-- bigserial id is monotonic, so (session_id, id) is a stable total order for
-- keyset pagination without a timestamp tiebreaker.
CREATE INDEX chat_messages_session_id_idx ON chat_messages (session_id, id);

-- ---------------------------------------------------------------------------
-- ai_interaction_logs
-- ---------------------------------------------------------------------------
-- Debugging a single conversation: WHERE session_id = $1 ORDER BY created_at
CREATE INDEX ai_logs_session_idx ON ai_interaction_logs (session_id, created_at)
  WHERE session_id IS NOT NULL;
-- Reliability dashboard: failures by provider over a window. Partial on
-- outcome <> 'ok': successes dominate and are never queried this way.
CREATE INDEX ai_logs_failures_idx ON ai_interaction_logs (provider, created_at DESC)
  WHERE outcome <> 'ok';
-- Cost/latency rollups: WHERE created_at >= $1
CREATE INDEX ai_logs_created_idx ON ai_interaction_logs (created_at DESC);

-- ---------------------------------------------------------------------------
-- idempotency_keys
-- ---------------------------------------------------------------------------
-- Replay lookup: WHERE business_id = $1 AND user_id = $2 AND key = $3 -> the PK.
-- Retention sweep: DELETE WHERE created_at < now() - interval '24 hours'
-- (no scheduler runs it in this prototype; the table stays correct, only grows).
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
-- FK index: ON DELETE CASCADE from appointments.
CREATE INDEX idempotency_keys_appointment_idx ON idempotency_keys (appointment_id) WHERE appointment_id IS NOT NULL;
