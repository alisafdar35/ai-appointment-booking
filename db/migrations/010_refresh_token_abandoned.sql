-- =============================================================================
-- 010_refresh_token_abandoned.sql
--
-- A refresh rotation whose response never reached the browser (a timeout
-- during a cold start) leaves the browser holding the old token and the server
-- holding a successor nobody has. Inside the reuse grace window the API now
-- treats that as an abandoned rotation: the unused successor is revoked and a
-- fresh pair issued.
--
-- `abandoned` marks a successor revoked that way. If it is presented after all
-- (its response did arrive, and a sibling tab's retry took over), it is a
-- superseded token, not one to recover again — without the mark it would look
-- like any rotated token and could take over the replacement in turn.
--
-- Adding a NOT NULL column with a constant default rewrites nothing on
-- Postgres 11+, so this is instant on an existing table.
-- =============================================================================

ALTER TABLE refresh_tokens
  ADD COLUMN abandoned boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN refresh_tokens.abandoned IS
  'Revoked as the unused successor of an abandoned rotation; presenting it again is superseded, never recovered.';
