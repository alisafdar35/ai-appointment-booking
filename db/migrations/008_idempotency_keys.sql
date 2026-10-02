-- =============================================================================
-- 008_idempotency_keys.sql
--
-- POST /api/appointments accepts an Idempotency-Key header so that a client
-- whose response was lost (a dropped connection, a timeout, a double-clicked
-- Confirm) can resend the same request and get the original booking back
-- instead of a second one or a confusing "you are already busy then" 409.
--
-- One row per (tenant, user, key). The primary key is what makes it race-safe:
-- the booking transaction inserts the row FIRST, so a concurrent request with
-- the same key blocks on that insert until the first commits (and then replays
-- its answer) or rolls back (and then books itself). Only successful bookings
-- are kept — a refusal rolls the row back with everything else, so the key can
-- be retried once the problem is fixed.
--
-- request_hash fingerprints the validated request, so the same key sent with
-- different booking details is refused instead of silently replayed.
-- response is the exact 201 body, so a replay is byte-for-byte what the
-- original caller would have seen. Both are written in the same transaction as
-- the claim and are never NULL once committed.
--
-- Retention: keys are honoured for 24 hours; an older row is taken over by the
-- next request that reuses its key (see the API's ON CONFLICT clause).
-- idempotency_keys_created_idx serves a periodic
--   DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'
-- sweep, which a scheduled job would run; none exists in this prototype, and
-- the table stays correct without it (it only grows).
-- =============================================================================

CREATE TABLE idempotency_keys (
  business_id    uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  key            text        NOT NULL CHECK (key ~ '^[\x21-\x7E]{1,255}$'),
  request_hash   bytea       NOT NULL CHECK (length(request_hash) = 32),
  appointment_id uuid        REFERENCES appointments (id) ON DELETE CASCADE,
  response       jsonb       CHECK (response IS NULL OR jsonb_typeof(response) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id, key),
  CONSTRAINT idempotency_keys_user_fk FOREIGN KEY (business_id, user_id)
    REFERENCES users (business_id, id) ON DELETE CASCADE
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
CREATE INDEX idempotency_keys_appointment_idx ON idempotency_keys (appointment_id) WHERE appointment_id IS NOT NULL;

COMMENT ON TABLE idempotency_keys IS
  'Idempotency-Key replay store for POST /api/appointments. Rows older than 24 h are dead and may be swept.';
