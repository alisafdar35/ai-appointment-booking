-- =============================================================================
-- verify.sql — proves the schema's non-obvious guarantees actually hold.
-- (The same checks run on every `npm test`, in test/integration/schema.test.ts.)
-- Run against a seeded database:  psql -f db/verify.sql
-- Each block is rolled back, so this is read-only in effect.
-- =============================================================================
\set ON_ERROR_STOP off
\echo '=== 1. Overlapping booking for the same service must be REJECTED ==='
-- Positioned relative to the seeded Whitening (ffff...0001), so the check does
-- not depend on the timezone this psql session happens to run in.
BEGIN;
INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
SELECT business_id, 'aaaaaaaa-0000-0000-0000-000000000003', service_id,
       starts_at + interval '30 minutes', ends_at + interval '30 minutes', 'pending'
FROM appointments WHERE id = 'ffffffff-0000-0000-0000-000000000001';
ROLLBACK;

\echo '=== 2. Back-to-back booking (starting as the seeded one ends) must be ALLOWED ==='
BEGIN;
INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
SELECT business_id, 'aaaaaaaa-0000-0000-0000-000000000003', service_id,
       ends_at, ends_at + interval '1 hour', 'pending'
FROM appointments WHERE id = 'ffffffff-0000-0000-0000-000000000001';
ROLLBACK;

\echo '=== 3. Booking a user from another tenant must be REJECTED ==='
BEGIN;
INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
VALUES ('11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000001',
        'cccccccc-0000-0000-0000-000000000001',
        now() + interval '40 days', now() + interval '40 days 30 minutes', 'pending');
ROLLBACK;

\echo '=== 4. A cancelled appointment must NOT block its slot (re-booking allowed) ==='
BEGIN;
INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
SELECT business_id, 'aaaaaaaa-0000-0000-0000-000000000002', service_id, starts_at, ends_at, 'confirmed'
FROM appointments WHERE id = 'ffffffff-0000-0000-0000-000000000004';
ROLLBACK;

\echo '=== 5. Linking an appointment to a conversation from another tenant must be REJECTED ==='
BEGIN;
INSERT INTO chat_sessions (id, business_id, user_id)
VALUES ('eeeeeeee-0000-0000-0000-0000000000ff','22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000001');
INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status, chat_session_id)
VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002',
        'cccccccc-0000-0000-0000-000000000001',
        now() + interval '41 days', now() + interval '41 days 30 minutes', 'pending',
        'eeeeeeee-0000-0000-0000-0000000000ff');
ROLLBACK;

\echo '=== 6. Dashboard query must use appointments_user_starts_idx with no Sort ==='
EXPLAIN (COSTS OFF) SELECT id, starts_at FROM appointments
WHERE business_id = '11111111-1111-1111-1111-111111111111'
  AND user_id     = 'aaaaaaaa-0000-0000-0000-000000000002'
ORDER BY starts_at DESC LIMIT 20;

\echo '=== 7. The same customer in two places at once (a different service) must be REJECTED ==='
BEGIN;
INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
SELECT business_id, user_id, 'cccccccc-0000-0000-0000-000000000001',
       starts_at + interval '15 minutes', starts_at + interval '45 minutes', 'pending'
FROM appointments WHERE id = 'ffffffff-0000-0000-0000-000000000001';
ROLLBACK;

\echo '=== 8. Every live appointment must sit inside its business''s opening days and hours, in its timezone (expect 0 rows) ==='
SELECT a.id, a.starts_at AT TIME ZONE b.timezone AS local_start, b.opens_at, b.closes_at, b.open_days
FROM appointments a
JOIN businesses b ON b.id = a.business_id
WHERE a.status IN ('pending', 'confirmed')
  AND (NOT EXTRACT(ISODOW FROM a.starts_at AT TIME ZONE b.timezone)::smallint = ANY (b.open_days)
    OR (a.starts_at AT TIME ZONE b.timezone)::time < b.opens_at
    OR (a.ends_at   AT TIME ZONE b.timezone)::time > b.closes_at
    OR (a.starts_at AT TIME ZONE b.timezone)::date <> (a.ends_at AT TIME ZONE b.timezone)::date);
