-- =============================================================================
-- 006_users_email_idx.sql
--
-- 002 noted that login is served by UNIQUE (business_id, email). That described
-- a query the API does not run: the default sign-in form sends no tenant, so
-- findUserForLogin filters on email alone (plus an optional slug, joined via
-- businesses). email is the second column of that unique index, so the lookup
-- could not seek on it and scanned users across every tenant on each login.
--
-- An index leading with email serves both forms: the slug-less lookup directly,
-- and the slug form by narrowing to the few accounts sharing an email before
-- the join checks the slug. 002 is checksummed and immutable, so its comment is
-- superseded here rather than edited.
-- =============================================================================

CREATE INDEX users_email_idx ON users (email);
