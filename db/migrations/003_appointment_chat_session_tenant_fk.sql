-- =============================================================================
-- 003_appointment_chat_session_tenant_fk.sql
--
-- 001 made every cross-row reference composite on (business_id, id), so that a
-- row cannot point into another tenant — except this one. appointments
-- referenced chat_sessions by id alone, which let an appointment in one tenant
-- be attached to a conversation in another. The target UNIQUE (business_id, id)
-- on chat_sessions already exists for exactly this purpose; this migration uses it.
--
-- ON DELETE SET NULL names the column: with a composite key a bare SET NULL
-- would also try to null business_id, which is NOT NULL. Losing a conversation
-- must still never delete the appointment it produced. (Column-list SET NULL
-- needs PostgreSQL 15+; the project targets 16.)
--
-- A NULL chat_session_id (every form booking) is not checked: a composite
-- foreign key with any NULL column is satisfied.
-- =============================================================================

ALTER TABLE appointments DROP CONSTRAINT appointments_chat_session_fk;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_chat_session_fk
  FOREIGN KEY (business_id, chat_session_id)
  REFERENCES chat_sessions (business_id, id)
  ON DELETE SET NULL (chat_session_id);
