-- =============================================================================
-- 009_one_booking_per_chat_session.sql
--
-- A conversation books at most one appointment. The API enforces that by
-- locking the chat_sessions row (SELECT ... FOR UPDATE) in every transaction
-- that links a booking to it, refusing a session that is no longer active and
-- completing it in the same transaction. Before that, a chat "yes" and a form
-- POST naming the same session could race past the per-process turn queue and
-- both commit.
--
-- This index is the backstop under the lock: whatever path writes the row, two
-- live appointments cannot name the same conversation. "Live" is the same
-- predicate the overlap constraints use, so the clean-up below only ever
-- cancels live rows and finished history (completed, no_show) is never
-- rewritten.
--
-- Existing data: as in 005, any session already holding several live
-- appointments keeps its earliest and the rest are cancelled with a reason,
-- so the index can always be built. The seed links one live appointment to
-- one session, so a seeded database is unchanged.
-- =============================================================================

UPDATE appointments later
SET status = 'cancelled',
    cancellation_reason = 'A second booking from the same conversation (migration 009)'
WHERE later.chat_session_id IS NOT NULL
  AND later.status IN ('pending', 'confirmed')
  AND EXISTS (
    SELECT 1 FROM appointments earlier
    WHERE earlier.chat_session_id = later.chat_session_id
      AND earlier.id <> later.id
      AND earlier.status IN ('pending', 'confirmed')
      AND (earlier.created_at, earlier.id) < (later.created_at, later.id)
  );

CREATE UNIQUE INDEX appointments_one_live_per_chat_session
  ON appointments (chat_session_id)
  WHERE chat_session_id IS NOT NULL AND status IN ('pending', 'confirmed');

COMMENT ON INDEX appointments_one_live_per_chat_session IS
  'A conversation holds at most one live appointment; backs the chat_sessions row lock taken by every booking that links one.';
