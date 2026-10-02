import type { UserDto, UserRole } from '@appt/shared';
import { pool, type Queryable } from '../../db/pool.js';
import { hashRefreshToken } from '../../lib/jwt.js';

/**
 * Data access for authentication.
 *
 * Raw parameterised SQL throughout. Every value reaches Postgres as a bound
 * parameter ($1, $2, ...) — there is no string interpolation of user input
 * anywhere in this codebase, which is what makes SQL injection structurally
 * impossible rather than merely unlikely.
 */

/**
 * The safe user projection, defined once.
 *
 * password_hash is absent on purpose: a query that cannot select the hash
 * cannot leak it through a response serialiser. The one place that needs it
 * (login) asks for it explicitly, below.
 */
const USER_SELECT = `
  SELECT u.id, u.email, u.full_name, u.phone, u.role, u.created_at,
         b.id AS business_id, b.name AS business_name, b.slug AS business_slug,
         b.timezone AS business_timezone
  FROM users u
  JOIN businesses b ON b.id = u.business_id
`;

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: UserRole;
  created_at: string;
  business_id: string;
  business_name: string;
  business_slug: string;
  business_timezone: string;
}

/** Row -> DTO. snake_case stays in the data layer; the API speaks camelCase. */
export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    businessId: row.business_id,
    businessName: row.business_name,
    businessSlug: row.business_slug,
    businessTimezone: row.business_timezone,
    createdAt: row.created_at,
  };
}

export async function findUserById(id: string): Promise<UserDto | null> {
  const { rows } = await pool.query<UserRow>(`${USER_SELECT} WHERE u.id = $1`, [id]);
  return rows[0] ? toUserDto(rows[0]) : null;
}

/** Login path: the only query that selects password_hash. */
export async function findUserForLogin(
  email: string,
  businessSlug?: string,
): Promise<(UserRow & { password_hash: string }) | null> {
  // With no slug, resolve by email alone. A platform where one email may exist
  // in several tenants needs a tenant hint to be unambiguous; this prototype
  // takes the oldest matching account and documents the limitation.
  const { rows } = await pool.query<UserRow & { password_hash: string }>(
    `${USER_SELECT.replace('SELECT u.id,', 'SELECT u.password_hash, u.id,')}
     WHERE u.email = $1
       AND ($2::citext IS NULL OR b.slug = $2::citext)
     ORDER BY u.created_at ASC
     LIMIT 1`,
    [email, businessSlug ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Both lookups below take the caller's connection. Inside a transaction they
 * must run on it: asking the pool for a second connection while holding one
 * deadlocks as soon as enough concurrent requests each hold one and wait for
 * another, which a burst of signups the size of the pool is enough to cause.
 */
export async function findBusinessBySlug(slug: string, client: Queryable = pool): Promise<{ id: string } | null> {
  const { rows } = await client.query<{ id: string }>('SELECT id FROM businesses WHERE slug = $1', [slug]);
  return rows[0] ?? null;
}

/** Held until the transaction ends; see the owner-signup rule in service.signup. */
export async function lockOwnerEmail(client: Queryable, email: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('owner-signup:' || lower($1), 0))`, [email]);
}

export async function ownsWorkspace(email: string, client: Queryable = pool): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 FROM users WHERE email = $1 AND role = 'owner' LIMIT 1`, [email]);
  return rows.length > 0;
}

export async function emailExistsInBusiness(
  businessId: string,
  email: string,
  client: Queryable = pool,
): Promise<boolean> {
  const { rows } = await client.query(
    'SELECT 1 FROM users WHERE business_id = $1 AND email = $2 LIMIT 1',
    [businessId, email],
  );
  return rows.length > 0;
}

/**
 * Create a tenant, or report that the slug is taken.
 *
 * `null` means another business already holds that slug. Taking it as an
 * outcome of the insert itself — rather than checking first and inserting after
 * — is what makes slug allocation safe when two signups pick the same name in
 * the same instant: whichever the database orders second simply sees `null`.
 */
export async function createBusiness(
  client: Queryable,
  input: { name: string; slug: string; timezone: string },
): Promise<{ id: string } | null> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, timezone) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id`,
    [input.name, input.slug, input.timezone],
  );
  return rows[0] ?? null;
}

/**
 * Give a brand-new business something bookable.
 *
 * An empty service catalogue would make the booking flow dead on arrival for
 * every new signup — the chatbot would have nothing to offer and the form would
 * render an empty select. Seeding a default catalogue is a product decision
 * made explicit in code.
 */
export async function createDefaultServices(client: Queryable, businessId: string): Promise<void> {
  await client.query(
    `INSERT INTO services (business_id, name, description, duration_minutes, price_cents)
     VALUES
       ($1, 'Initial Consultation', 'Introductory session to discuss your needs.', 30, 0),
       ($1, 'Standard Appointment',  'A regular 45 minute booking.',               45, 0),
       ($1, 'Extended Session',      'A longer 90 minute appointment.',            90, 0)`,
    [businessId],
  );
}

export async function createUser(
  client: Queryable,
  input: {
    businessId: string;
    email: string;
    passwordHash: string;
    fullName: string;
    phone?: string | undefined;
    role: UserRole;
  },
): Promise<UserDto> {
  const { rows } = await client.query<UserRow>(
    `WITH inserted AS (
       INSERT INTO users (business_id, email, password_hash, full_name, phone, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, full_name, phone, role, created_at, business_id
     )
     SELECT i.id, i.email, i.full_name, i.phone, i.role, i.created_at,
            b.id AS business_id, b.name AS business_name, b.slug AS business_slug,
            b.timezone AS business_timezone
     FROM inserted i JOIN businesses b ON b.id = i.business_id`,
    [input.businessId, input.email, input.passwordHash, input.fullName, input.phone ?? null, input.role],
  );
  return toUserDto(rows[0]!);
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export async function storeRefreshToken(
  client: Queryable,
  input: { userId: string; token: string; expiresAt: Date; userAgent?: string | undefined },
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.userId, hashRefreshToken(input.token), input.expiresAt, input.userAgent ?? null],
  );
  return rows[0]!;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  expires_at: string;
  revoked_at: string | null;
}

export async function findRefreshToken(token: string): Promise<RefreshTokenRow | null> {
  const { rows } = await pool.query<RefreshTokenRow>(
    `SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1`,
    [hashRefreshToken(token)],
  );
  return rows[0] ?? null;
}

/**
 * Revoke one token, reporting whether this call is the one that did it.
 *
 * `false` means it was already revoked. The rotation flow relies on that to
 * tell the winner of a concurrent redemption from the loser.
 */
export async function revokeRefreshToken(
  client: Queryable,
  id: string,
  replacedBy?: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2
     WHERE id = $1 AND revoked_at IS NULL`,
    [id, replacedBy ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/** What a presented, already-revoked token's rotation looks like, read under row locks. */
export interface RotationState {
  /** Revoked within the grace window, on the database clock that wrote `revoked_at`. */
  recent: boolean;
  /** Itself the unused successor of a rotation that was abandoned and replaced. */
  abandoned: boolean;
  /** The token that replaced it; null when it was ended by a logout. */
  successorId: string | null;
  /** That successor is still live: nobody has presented or signed it out. */
  successorUnused: boolean;
}

/**
 * Lock a revoked token and its successor, one at a time and the presented
 * token first, so two retries of one token queue on it and the second sees
 * what the first left.
 */
export async function lockRotation(client: Queryable, id: string, graceSeconds: number): Promise<RotationState> {
  const { rows } = await client.query<{ replaced_by: string | null; abandoned: boolean; recent: boolean }>(
    `SELECT replaced_by, abandoned, revoked_at > now() - make_interval(secs => $2) AS recent
     FROM refresh_tokens WHERE id = $1 FOR UPDATE`,
    [id, graceSeconds],
  );
  const row = rows[0]!;
  const successor = row.replaced_by
    ? await client.query<{ unused: boolean }>(
        'SELECT revoked_at IS NULL AS unused FROM refresh_tokens WHERE id = $1 FOR UPDATE',
        [row.replaced_by],
      )
    : null;
  return {
    recent: row.recent,
    abandoned: row.abandoned,
    successorId: row.replaced_by,
    successorUnused: successor?.rows[0]?.unused ?? false,
  };
}

/**
 * Replace the abandoned successor of `id` with `replacementId`: the successor
 * is revoked and marked, and `id` now points at the replacement, so a further
 * retry of `id` finds the replacement as its successor.
 */
export async function replaceAbandonedSuccessor(
  client: Queryable,
  id: string,
  successorId: string,
  replacementId: string,
): Promise<void> {
  await client.query(
    `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2, abandoned = true WHERE id = $1`,
    [successorId, replacementId],
  );
  await client.query(`UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1`, [id, replacementId]);
}

/**
 * Revoke every live token for a user.
 *
 * Called on logout-everywhere and, importantly, when a already-rotated refresh
 * token is presented again — see the service layer for why.
 */
export async function revokeAllForUser(client: Queryable, userId: string): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return rowCount ?? 0;
}
