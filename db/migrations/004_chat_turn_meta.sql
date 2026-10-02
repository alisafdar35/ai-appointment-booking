-- =============================================================================
-- 004_chat_turn_meta.sql
--
-- 1. chat_messages.meta — the outcome of an assistant turn, stored with it:
--      { "action": "confirm", "suggestions": [...], "missing": [...] }
--    The session's booking_draft only describes the latest state, so without
--    this a reloaded transcript is plain text: the confirmation card and the
--    offered alternative times exist only in the tab that received them live.
--    jsonb rather than columns: it is read and written as one value, never
--    filtered on, and its shape follows the API contract rather than a query.
--    Nullable: user messages have no outcome, and rows written before this
--    migration simply restore without controls.
--
-- 2. chat_messages.engine gains 'system': turns produced with no language
--    understanding at all (the structured booking form). Labelling those
--    'fallback' told the user the AI had degraded when nothing had.
--
-- 3. ai_interaction_logs.guardrails — what the application corrected in a
--    model answer it otherwise accepted (a date the model resolved wrongly, a
--    reply that claimed a booking which does not exist). The call itself
--    succeeded, so these are not outcomes; they are how often a successful
--    answer still could not be taken at its word.
-- =============================================================================

ALTER TABLE chat_messages
  ADD COLUMN meta jsonb CHECK (meta IS NULL OR jsonb_typeof(meta) = 'object');

COMMENT ON COLUMN chat_messages.meta IS
  'Assistant turns only: {action, suggestions?, missing}, so a reloaded transcript restores the UI the turn produced.';

ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_engine_check;
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_engine_check
  CHECK (engine IS NULL OR engine IN ('mistral', 'fallback', 'system'));

COMMENT ON COLUMN chat_messages.engine IS
  'Who produced an assistant turn: the LLM (mistral), the deterministic extractor (fallback), or plain code with no language understanding (system).';

ALTER TABLE ai_interaction_logs
  ADD COLUMN guardrails jsonb CHECK (guardrails IS NULL OR jsonb_typeof(guardrails) = 'array');

COMMENT ON COLUMN ai_interaction_logs.guardrails IS
  'Corrections applied to an accepted model answer, e.g. [{"kind":"date_corrected","model":"2026-10-08","deterministic":"2026-10-07"}].';

COMMENT ON COLUMN ai_interaction_logs.outcome IS
  'ok | timeout | rate_limited | auth_error | invalid_output | provider_error';
