-- =============================================================================
-- seed.sql — sample data for local development and review
--
-- Idempotent: safe to run repeatedly. Rows with a fixed id conflict-skip on
-- that id; rows without one (messages, AI logs) are guarded explicitly.
-- Password hashes are generated here by pgcrypto's crypt()/gen_salt('bf', 12),
-- which emits standard $2a$ bcrypt that the API's bcryptjs verifies directly.
-- That keeps this file runnable with psql alone — no Node required.
--
-- Demo credentials (both tenants):
--   owner@bluewave.test    / Password123!   (role: owner)
--   customer@bluewave.test / Password123!   (role: customer)
--   owner@northside.test   / Password123!   (second tenant, for isolation testing)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

BEGIN;

-- ---------------------------------------------------------------------------
-- Two tenants. The second exists so tenant isolation can be demonstrated
-- rather than merely claimed.
-- ---------------------------------------------------------------------------
INSERT INTO businesses (id, name, slug, timezone, opens_at, closes_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Bluewave Dental',  'bluewave',  'America/New_York', '09:00', '17:00'),
  ('22222222-2222-2222-2222-222222222222', 'Northside Clinic', 'northside', 'Europe/London',    '08:00', '18:00')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
INSERT INTO users (id, business_id, email, password_hash, full_name, phone, role) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'owner@bluewave.test',    crypt('Password123!', gen_salt('bf', 12)), 'Dana Whitfield', '+1 555 0100', 'owner'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'customer@bluewave.test', crypt('Password123!', gen_salt('bf', 12)), 'Marcus Reed',    '+1 555 0142', 'customer'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'staff@bluewave.test',    crypt('Password123!', gen_salt('bf', 12)), 'Priya Raman',    NULL,          'staff'),
  -- Same email local-part in a different tenant: permitted, and the reason the
  -- unique constraint is (business_id, email) rather than (email).
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'owner@northside.test',   crypt('Password123!', gen_salt('bf', 12)), 'Tom Alvarez',    NULL,          'owner')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Services — duration_minutes is what lets the AI extract only a start time
-- ---------------------------------------------------------------------------
INSERT INTO services (id, business_id, name, description, duration_minutes, price_cents) VALUES
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'Routine Checkup',   'Standard examination and cleaning.',        30,  8000),
  ('cccccccc-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'Teeth Whitening',   'Professional in-chair whitening.',          60, 24000),
  ('cccccccc-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'Emergency Consult', 'Same-day assessment for acute pain.',       20, 12000),
  ('cccccccc-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
   'Orthodontic Review','Follow-up for existing treatment plans.',    45, 15000),
  ('dddddddd-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'General Practice',  'Standard GP appointment.',                   15,  0)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Every seeded time is a wall-clock time in the business's own timezone.
--
-- Times are derived from now() so the data is always current whenever a
-- reviewer runs this, but now() is an instant: date_trunc('day', now()) would
-- cut it at midnight in the *session's* timezone, so "14:00" would mean 14:00
-- in Karachi on a laptop and 14:00 UTC on Neon — 5 AM or 10 AM in New York,
-- outside the opening hours the API enforces. Converting to the business zone
-- first, truncating there and converting back is what the booking path does too
-- (repository.create: local date + time AT TIME ZONE business.timezone).
--
-- seed_local_day(N) is "N days from today, in Bluewave's calendar". It is a
-- temporary function: it exists for the length of this session only, so the
-- seed adds nothing to the schema.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.seed_local_day(days int) RETURNS timestamp
LANGUAGE sql STABLE AS $$
  SELECT date_trunc('day', now() AT TIME ZONE b.timezone) + make_interval(days => days)
  FROM businesses b WHERE b.id = '11111111-1111-1111-1111-111111111111'
$$;

-- ---------------------------------------------------------------------------
-- A completed AI conversation that produced a real booking.
-- Seeded so the chat UI, transcript and booking provenance are all visible on
-- first load instead of requiring the reviewer to generate data first.
--
-- The conversation, its draft and appointment ffff...0001 below all describe
-- the same slot, three days out at 14:00, so the day the transcript names is
-- derived from that date rather than written in. The wording follows what the
-- API itself writes: the confirmation and "Booked" replies are composed by code
-- (copy.ts confirmationPrompt, chat/service.ts), only the first reply is model
-- prose, tool_calls has the shape chat/service.ts stores, and each turn's
-- engine agrees with the AI log rows further down.
-- ---------------------------------------------------------------------------
INSERT INTO chat_sessions (id, business_id, user_id, title, status, booking_draft, message_count, last_message_at)
SELECT 'eeeeeeee-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
       'aaaaaaaa-0000-0000-0000-000000000002',
       'Teeth Whitening — ' || to_char(d.day, 'Dy, Mon FMDD'), 'completed',
       jsonb_build_object('serviceName', 'Teeth Whitening', 'date', to_char(d.day, 'YYYY-MM-DD'),
                          'time', '14:00', 'notes', 'Prefers afternoon'),
       6, now() - interval '2 days'
FROM (SELECT pg_temp.seed_local_day(3) AS day) d
ON CONFLICT (id) DO NOTHING;

-- Messages have no natural key to conflict on, so the transcript is guarded as
-- a unit: inserted only while the seeded session has no messages at all. Without
-- this, every re-run would append a second copy of the conversation.
-- `meta` is what each assistant turn told the UI to show (see migration 004).
INSERT INTO chat_messages (session_id, role, content, engine, tool_calls, meta, created_at)
SELECT 'eeeeeeee-0000-0000-0000-000000000001', m.role::chat_message_role, m.content, m.engine, m.tool_calls, m.meta::jsonb, m.created_at
FROM (SELECT to_char(pg_temp.seed_local_day(3), 'YYYY-MM-DD') AS iso,
             to_char(pg_temp.seed_local_day(3), 'FMDay, FMMonth FMDD, YYYY') AS long_date,
             lower(to_char(pg_temp.seed_local_day(3), 'FMDay')) AS weekday) d
CROSS JOIN LATERAL (VALUES
  ('user',
   'hi, i want to get my teeth whitened in the next few days', NULL, NULL::jsonb, NULL,
   now() - interval '2 days 6 minutes'),
  ('assistant',
   'Happy to help with Teeth Whitening — that is a 60 minute appointment. Which day and time suit you?',
   'mistral',
   jsonb_build_array(jsonb_build_object('name', 'respond_to_booking_request', 'intent', 'collecting',
     'arguments', jsonb_build_object('serviceName', 'Teeth Whitening'))),
   '{"action":"collect_info","missing":["date","time"]}',
   now() - interval '2 days 5 minutes'),
  ('user',
   d.weekday || ' at 2pm if you have it, i prefer afternoons', NULL, NULL::jsonb, NULL,
   now() - interval '2 days 4 minutes'),
  ('assistant',
   'Just to confirm: Teeth Whitening on ' || d.long_date || ' at 2:00 PM. Shall I book it?',
   'mistral',
   jsonb_build_array(jsonb_build_object('name', 'respond_to_booking_request', 'intent', 'collecting',
     'arguments', jsonb_build_object('date', d.iso, 'time', '14:00', 'notes', 'Prefers afternoon'))),
   '{"action":"confirm","missing":[]}',
   now() - interval '2 days 3 minutes'),
  ('user',
   'yes please', NULL, NULL::jsonb, NULL,
   now() - interval '2 days 2 minutes'),
  ('assistant',
   'Booked — Teeth Whitening on ' || d.long_date || ' at 2:00 PM. It''s on your dashboard now.',
   -- The model timed out on this turn (req_seed_003 below) and the deterministic
   -- engine read the "yes", so the turn is attributed to it, as the API would.
   'fallback',
   jsonb_build_array(jsonb_build_object('name', 'respond_to_booking_request', 'intent', 'confirming',
     'arguments', '{}'::jsonb)),
   '{"action":"booked","missing":[]}',
   now() - interval '2 days 1 minute')
) AS m(role, content, engine, tool_calls, meta, created_at)
WHERE NOT EXISTS (
  SELECT 1 FROM chat_messages WHERE session_id = 'eeeeeeee-0000-0000-0000-000000000001'
);

-- ---------------------------------------------------------------------------
-- Appointments, all inside Bluewave's 09:00-17:00 in its own timezone (see
-- seed_local_day above). The customer's live bookings do not overlap each
-- other, which appointments_customer_no_overlap (migration 005) requires.
-- ---------------------------------------------------------------------------
INSERT INTO appointments
  (id, business_id, user_id, service_id, starts_at, ends_at, status, source, notes, chat_session_id)
SELECT a.id::uuid, '11111111-1111-1111-1111-111111111111', a.user_id::uuid, a.service_id::uuid,
       (pg_temp.seed_local_day(a.day_offset) + a.local_start) AT TIME ZONE b.timezone,
       (pg_temp.seed_local_day(a.day_offset) + a.local_start + make_interval(mins => s.duration_minutes))
         AT TIME ZONE b.timezone,
       a.status::appointment_status, a.source::appointment_source, a.notes, a.chat_session_id::uuid
FROM (VALUES
  -- Booked through the chatbot (note the source + session provenance).
  ('ffffffff-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002',
   'cccccccc-0000-0000-0000-000000000002', 3, interval '14 hours',
   'confirmed', 'chat', 'Prefers afternoon', 'eeeeeeee-0000-0000-0000-000000000001'),

  -- Booked through the structured form. Pending is reserved for a booking
  -- awaiting staff approval; the API itself books straight to confirmed.
  ('ffffffff-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002',
   'cccccccc-0000-0000-0000-000000000001', 5, interval '10 hours',
   'pending', 'form', NULL, NULL),

  -- Past, completed — gives the dashboard a history tab with content.
  ('ffffffff-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002',
   'cccccccc-0000-0000-0000-000000000001', -20, interval '11 hours',
   'completed', 'form', NULL, NULL),

  -- Cancelled — demonstrates that the EXCLUDE constraint's status predicate
  -- frees the slot for rebooking.
  ('ffffffff-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000003',
   'cccccccc-0000-0000-0000-000000000003', 1, interval '9 hours',
   'cancelled', 'chat', NULL, NULL)
) AS a(id, user_id, service_id, day_offset, local_start, status, source, notes, chat_session_id)
JOIN businesses b ON b.id = '11111111-1111-1111-1111-111111111111'
JOIN services s ON s.id = a.service_id::uuid
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- AI interaction logs — including a failure and its fallback, because the
-- interesting rows in an observability table are the ones that went wrong.
-- ---------------------------------------------------------------------------
-- Guarded per row by request_id, for the same reason as the messages above.
INSERT INTO ai_interaction_logs
  (business_id, session_id, request_id, provider, model, latency_ms,
   prompt_tokens, completion_tokens, outcome, error_message, extracted_slots)
SELECT l.business_id::uuid, l.session_id::uuid, l.request_id, l.provider, l.model, l.latency_ms,
       l.prompt_tokens, l.completion_tokens, l.outcome, l.error_message, l.extracted_slots::jsonb
FROM (VALUES
  ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-0000-0000-0000-000000000001',
   'req_seed_001', 'mistral', 'ministral-8b-latest', 742, 486, 58, 'ok', NULL,
   '{"serviceName":"Teeth Whitening"}'),
  ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-0000-0000-0000-000000000001',
   'req_seed_002', 'mistral', 'ministral-8b-latest', 915, 604, 71, 'ok', NULL,
   '{"date":"' || to_char(pg_temp.seed_local_day(3), 'YYYY-MM-DD') || '","time":"14:00","notes":"Prefers afternoon"}'),
  ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-0000-0000-0000-000000000001',
   'req_seed_003', 'mistral', 'ministral-8b-latest', 8000, NULL, NULL, 'timeout',
   'Provider did not respond within 8000ms', NULL),
  ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-0000-0000-0000-000000000001',
   'req_seed_004', 'fallback', NULL, 3, NULL, NULL, 'ok',
   'Served by deterministic extractor after provider timeout',
   '{}')
) AS l(business_id, session_id, request_id, provider, model, latency_ms,
       prompt_tokens, completion_tokens, outcome, error_message, extracted_slots)
WHERE NOT EXISTS (SELECT 1 FROM ai_interaction_logs a WHERE a.request_id = l.request_id);

COMMIT;

-- Quick verification.
SELECT 'businesses' AS table, count(*) FROM businesses
UNION ALL SELECT 'users',          count(*) FROM users
UNION ALL SELECT 'services',       count(*) FROM services
UNION ALL SELECT 'appointments',   count(*) FROM appointments
UNION ALL SELECT 'chat_sessions',  count(*) FROM chat_sessions
UNION ALL SELECT 'chat_messages',  count(*) FROM chat_messages
UNION ALL SELECT 'ai_logs',        count(*) FROM ai_interaction_logs;
