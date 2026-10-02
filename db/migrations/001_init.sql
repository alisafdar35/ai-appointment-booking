-- =============================================================================
-- 001_init.sql — core schema
--
-- Design notes (expanded in docs/database.md):
--  * Multi-tenant from day one: every tenant-scoped row carries business_id.
--    Cross-row references use COMPOSITE foreign keys on (business_id, id) so the
--    database itself makes it impossible to attach a row to the wrong tenant —
--    a guarantee application code can forget to make, but SQL cannot.
--  * Native ENUMs are used for stable value sets. Tradeoff: adding a value is a
--    cheap ALTER TYPE, but renaming/removing one needs a migration dance. These
--    sets are stable enough that DB-level type safety is the better trade.
--  * Appointment overlap is prevented by an EXCLUDE constraint, not app logic.
--    Two concurrent bookings for the same slot cannot both commit.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- GIST support for scalar =, needed by EXCLUDE below
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email without lower() everywhere

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE user_role          AS ENUM ('owner', 'staff', 'customer');
CREATE TYPE appointment_status AS ENUM ('pending', 'confirmed', 'cancelled', 'completed', 'no_show');
CREATE TYPE appointment_source AS ENUM ('chat', 'form', 'admin');
CREATE TYPE chat_message_role  AS ENUM ('user', 'assistant', 'system', 'tool');
CREATE TYPE chat_session_status AS ENUM ('active', 'completed', 'abandoned');

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- businesses — the tenant root
-- ---------------------------------------------------------------------------
CREATE TABLE businesses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  slug        citext      NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  timezone    text        NOT NULL DEFAULT 'UTC',
  -- Booking policy, read by the AI service to answer "are you open then?"
  opens_at    time        NOT NULL DEFAULT '09:00',
  closes_at   time        NOT NULL DEFAULT '17:00',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT businesses_hours_ordered CHECK (closes_at > opens_at)
);
CREATE TRIGGER businesses_set_updated_at BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE businesses IS 'Tenant root. Every tenant-scoped table references this via business_id.';

-- ---------------------------------------------------------------------------
-- users — authentication + profile
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email         citext      NOT NULL CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  password_hash text        NOT NULL,
  full_name     text        NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 160),
  phone         text        CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()-]{6,24}$'),
  role          user_role   NOT NULL DEFAULT 'customer',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Email is unique PER TENANT, not globally: the same person may hold an
  -- account with two businesses on the platform.
  CONSTRAINT users_business_email_key UNIQUE (business_id, email),
  -- Target for composite FKs from child tables (see appointments/chat_sessions).
  CONSTRAINT users_business_id_id_key  UNIQUE (business_id, id)
);
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN users.password_hash IS 'bcrypt, cost 12. Never leaves the repository layer.';

-- ---------------------------------------------------------------------------
-- refresh_tokens — rotating refresh tokens, stored hashed
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the opaque token. A database leak must not yield usable sessions.
  token_hash  bytea       NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  -- Set when the token is consumed by a rotation; retained so that replaying a
  -- rotated token can be detected as theft and the whole family revoked.
  revoked_at  timestamptz,
  replaced_by uuid        REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_tokens_expiry_future CHECK (expires_at > created_at)
);

COMMENT ON TABLE refresh_tokens IS
  'Rotating refresh tokens. Reuse of a revoked token revokes every live token for that user.';

-- ---------------------------------------------------------------------------
-- services — what can actually be booked
-- ---------------------------------------------------------------------------
CREATE TABLE services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description      text,
  duration_minutes integer     NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  price_cents      integer     NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT services_business_name_key UNIQUE (business_id, name),
  CONSTRAINT services_business_id_id_key UNIQUE (business_id, id)
);
CREATE TRIGGER services_set_updated_at BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE services IS
  'Bookable service catalogue. duration_minutes drives appointment end times, so the AI only needs to extract a start time.';

-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  user_id     uuid NOT NULL,
  service_id  uuid NOT NULL,

  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  -- Generated range column: lets one GIST index serve both overlap detection
  -- and calendar range queries. '[)' so 10:00-10:30 and 10:30-11:00 do NOT clash.
  slot        tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,

  status      appointment_status NOT NULL DEFAULT 'pending',
  source      appointment_source NOT NULL DEFAULT 'form',
  notes       text CHECK (notes IS NULL OR length(notes) <= 2000),
  cancellation_reason text CHECK (cancellation_reason IS NULL OR length(cancellation_reason) <= 500),

  -- Provenance: which conversation produced this booking. Nullable because
  -- form bookings have no session. ON DELETE SET NULL — losing chat history
  -- must never delete a real appointment.
  chat_session_id uuid,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT appointments_time_ordered CHECK (ends_at > starts_at),

  -- Composite FKs: the referenced user and service must live in the SAME tenant.
  CONSTRAINT appointments_user_fk FOREIGN KEY (business_id, user_id)
    REFERENCES users (business_id, id) ON DELETE CASCADE,
  CONSTRAINT appointments_service_fk FOREIGN KEY (business_id, service_id)
    REFERENCES services (business_id, id) ON DELETE RESTRICT,

  -- Integrity, enforced by the database rather than by a read-then-write race:
  -- no two live appointments for the same service may overlap in time.
  CONSTRAINT appointments_no_overlap EXCLUDE USING gist (
    business_id WITH =,
    service_id  WITH =,
    slot        WITH &&
  ) WHERE (status IN ('pending', 'confirmed'))
);
CREATE TRIGGER appointments_set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON CONSTRAINT appointments_no_overlap ON appointments IS
  'Double-booking is a data integrity problem, so it is solved in the schema. Cancelled/completed rows are excluded so a freed slot is immediately rebookable.';

-- ---------------------------------------------------------------------------
-- chat_sessions — one conversation; carries the AI booking draft
-- ---------------------------------------------------------------------------
CREATE TABLE chat_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  user_id     uuid NOT NULL,
  title       text NOT NULL DEFAULT 'New conversation' CHECK (length(title) <= 200),
  status      chat_session_status NOT NULL DEFAULT 'active',

  -- Partially-filled booking slots accumulated across turns. Living in the
  -- session row (not in the model's context) means a refresh, a new tab or an
  -- LLM outage never loses what the user already told us.
  booking_draft jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(booking_draft) = 'object'),

  message_count   integer     NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chat_sessions_user_fk FOREIGN KEY (business_id, user_id)
    REFERENCES users (business_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_sessions_business_id_id_key UNIQUE (business_id, id)
);
CREATE TRIGGER chat_sessions_set_updated_at BEFORE UPDATE ON chat_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Deferred to here because chat_sessions is defined after appointments.
ALTER TABLE appointments
  ADD CONSTRAINT appointments_chat_session_fk FOREIGN KEY (chat_session_id)
  REFERENCES chat_sessions (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- chat_messages — the transcript
-- ---------------------------------------------------------------------------
CREATE TABLE chat_messages (
  id         bigserial PRIMARY KEY,   -- monotonic: doubles as a stable sort key
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role       chat_message_role NOT NULL,
  content    text NOT NULL CHECK (length(content) <= 8000),

  -- Structured slots the model extracted on this turn, kept for debugging and
  -- for replaying a conversation without re-calling the provider.
  tool_calls jsonb CHECK (tool_calls IS NULL OR jsonb_typeof(tool_calls) = 'array'),
  -- Which engine produced an assistant turn: 'mistral' | 'fallback' | NULL for user turns.
  engine     text CHECK (engine IS NULL OR engine IN ('mistral', 'fallback')),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN chat_messages.engine IS
  'Records whether a reply came from the LLM or the deterministic fallback extractor.';

-- ---------------------------------------------------------------------------
-- ai_interaction_logs — observability for every provider call
-- ---------------------------------------------------------------------------
CREATE TABLE ai_interaction_logs (
  id             bigserial PRIMARY KEY,
  business_id    uuid REFERENCES businesses(id) ON DELETE SET NULL,
  session_id     uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  request_id     text,            -- correlates with the API access log
  provider       text NOT NULL,   -- 'mistral' | 'fallback'
  model          text,
  latency_ms     integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  prompt_tokens     integer CHECK (prompt_tokens     IS NULL OR prompt_tokens     >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  -- 'ok' | 'timeout' | 'rate_limited' | 'invalid_output' | 'provider_error'
  outcome        text NOT NULL,
  error_message  text,
  extracted_slots jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ai_interaction_logs IS
  'One row per provider call, including failures and fallbacks. Makes AI cost, latency and reliability measurable instead of anecdotal.';
