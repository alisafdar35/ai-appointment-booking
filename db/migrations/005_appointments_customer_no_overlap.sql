-- =============================================================================
-- 005_appointments_customer_no_overlap.sql
--
-- appointments_no_overlap (001) is keyed on (business_id, service_id, slot): it
-- models each service as one bookable resource — one chair per service — so two
-- different services may run at the same moment. That is the intended capacity
-- model, but it left a gap: nothing stopped ONE customer from holding two of
-- those overlapping appointments, a booking nobody can actually attend.
--
-- This adds the per-customer rule as a second EXCLUDE constraint, so it is
-- enforced by the database under concurrency exactly like the first one, with
-- the same live-status predicate: a cancelled or completed booking blocks
-- nothing.
--
-- Existing data: the constraint cannot be created while violating rows exist,
-- and before this migration the API accepted them. Rather than fail on any
-- database that took such a booking, the later-created appointment of each
-- overlapping pair is cancelled first, with a reason that says why. In this
-- prototype only demo and test data can be affected; a database holding real
-- customers' bookings would want those rows reviewed by a person instead.
-- =============================================================================

UPDATE appointments later
SET status = 'cancelled',
    cancellation_reason = 'Overlapped another booking by the same customer (migration 005)'
WHERE later.status IN ('pending', 'confirmed')
  AND EXISTS (
    SELECT 1 FROM appointments earlier
    WHERE earlier.business_id = later.business_id
      AND earlier.user_id     = later.user_id
      AND earlier.id         <> later.id
      AND earlier.status IN ('pending', 'confirmed')
      AND earlier.slot && later.slot
      AND (earlier.created_at, earlier.id) < (later.created_at, later.id)
  );

ALTER TABLE appointments
  ADD CONSTRAINT appointments_customer_no_overlap EXCLUDE USING gist (
    business_id WITH =,
    user_id     WITH =,
    slot        WITH &&
  ) WHERE (status IN ('pending', 'confirmed'));

COMMENT ON CONSTRAINT appointments_no_overlap ON appointments IS
  'One resource per service: no two live appointments for the same service may overlap. Different services may run concurrently.';

COMMENT ON CONSTRAINT appointments_customer_no_overlap ON appointments IS
  'A customer cannot hold two live appointments at the same time, whichever services they are for.';
