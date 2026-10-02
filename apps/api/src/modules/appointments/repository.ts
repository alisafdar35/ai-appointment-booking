import type { AppointmentDto, AppointmentSource, AppointmentStatus, ListAppointmentsInput, ServiceDto } from '@appt/shared';
import { pool, type Queryable } from '../../db/pool.js';

/**
 * Appointment data access.
 *
 * Every query is tenant-scoped by business_id in its WHERE clause. The business
 * id comes from the verified JWT, never from the request body, so a caller
 * cannot read or write another tenant's rows by guessing an id.
 */

const APPOINTMENT_SELECT = `
  SELECT a.id, a.status, a.source, a.starts_at, a.ends_at, a.notes,
         a.cancellation_reason, a.chat_session_id, a.created_at,
         s.id AS service_id, s.name AS service_name, s.description AS service_description,
         s.duration_minutes, s.price_cents,
         u.id AS customer_id, u.full_name AS customer_name, u.email AS customer_email
  FROM appointments a
  JOIN services s ON s.id = a.service_id
  JOIN users    u ON u.id = a.user_id
`;

interface AppointmentRow {
  id: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  cancellation_reason: string | null;
  chat_session_id: string | null;
  created_at: string;
  service_id: string;
  service_name: string;
  service_description: string | null;
  duration_minutes: number;
  price_cents: number;
  customer_id: string;
  customer_name: string;
  customer_email: string;
}

function toDto(row: AppointmentRow): AppointmentDto {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    notes: row.notes,
    cancellationReason: row.cancellation_reason,
    chatSessionId: row.chat_session_id,
    createdAt: row.created_at,
    service: {
      id: row.service_id,
      name: row.service_name,
      description: row.service_description,
      durationMinutes: row.duration_minutes,
      priceCents: row.price_cents,
    },
    customer: { id: row.customer_id, fullName: row.customer_name, email: row.customer_email },
  };
}

/**
 * List appointments, for one user or for the whole tenant.
 *
 * Filters are composed by pushing parameters onto an array rather than by
 * interpolating SQL, so adding a filter can never introduce an injection point.
 *
 * The order depends on what the caller is asking for. History reads newest
 * first, and so does the unfiltered list. "Upcoming" reads soonest first: the
 * limit cuts off the far end of the list, and for a calendar the far end is
 * the part that can wait — newest-first would drop tomorrow's appointments
 * whenever more than `limit` are booked. Both orders are served by
 * appointments_user_starts_idx (an index can be read in either direction).
 */
export async function list(
  businessId: string,
  filters: ListAppointmentsInput,
  userId?: string,
): Promise<AppointmentDto[]> {
  const params: unknown[] = [businessId];
  const where = ['a.business_id = $1'];

  if (userId) {
    params.push(userId);
    where.push(`a.user_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`a.status = ANY($${params.length}::appointment_status[])`);
  }
  if (filters.window === 'upcoming') where.push('a.starts_at >= now()');
  if (filters.window === 'past') where.push('a.starts_at < now()');

  params.push(filters.limit);
  const direction = filters.window === 'upcoming' ? 'ASC' : 'DESC';

  const { rows } = await pool.query<AppointmentRow>(
    `${APPOINTMENT_SELECT}
     WHERE ${where.join(' AND ')}
     ORDER BY a.starts_at ${direction}
     LIMIT $${params.length}`,
    params,
  );
  return rows.map(toDto);
}

export async function findById(
  businessId: string,
  id: string,
  client: Queryable = pool,
): Promise<AppointmentDto | null> {
  const { rows } = await client.query<AppointmentRow>(
    `${APPOINTMENT_SELECT} WHERE a.business_id = $1 AND a.id = $2`,
    [businessId, id],
  );
  return rows[0] ? toDto(rows[0]) : null;
}

/**
 * Insert an appointment, converting the business-local wall clock to an instant
 * inside the database.
 *
 *   ($4 || ' ' || $5)::timestamp AT TIME ZONE b.timezone
 *
 * Postgres owns this conversion because it ships and maintains the IANA
 * timezone database; doing it in Node would add a dependency that can disagree
 * with the database about when DST changed. ends_at is derived from the
 * service's duration in the same statement, so a client cannot request a
 * 30-minute service and book a three-hour block.
 */
export async function create(
  client: Queryable,
  input: {
    businessId: string;
    userId: string;
    serviceId: string;
    date: string;
    time: string;
    notes?: string | undefined;
    source: AppointmentSource;
    chatSessionId?: string | undefined;
  },
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    // Bookings are confirmed on creation: every rule has been checked, and there
    // is no approval step. The column defaults to 'pending' so that a row
    // written by anything else is never silently treated as confirmed.
    `INSERT INTO appointments
       (business_id, user_id, service_id, starts_at, ends_at, notes, source, chat_session_id, status)
     SELECT
       b.id, $2, s.id,
       ($4 || ' ' || $5)::timestamp AT TIME ZONE b.timezone,
       (($4 || ' ' || $5)::timestamp AT TIME ZONE b.timezone)
         + make_interval(mins => s.duration_minutes),
       $6, $7, $8, 'confirmed'
     FROM businesses b
     JOIN services s ON s.business_id = b.id AND s.id = $3 AND s.is_active
     WHERE b.id = $1
     RETURNING id`,
    [
      input.businessId,
      input.userId,
      input.serviceId,
      input.date,
      input.time,
      // A blank note is no note: store NULL so a client never has to tell "" from absent.
      input.notes || null,
      input.source,
      input.chatSessionId ?? null,
    ],
  );
  // No row means the JOIN found no active service in this tenant; the service
  // layer reports that as the service not being found.
  return rows[0]?.id ?? null;
}

/** Is this conversation the caller's own, in their tenant? */
export async function ownsChatSession(
  ctx: { businessId: string; userId: string },
  sessionId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM chat_sessions WHERE id = $1 AND business_id = $2 AND user_id = $3',
    [sessionId, ctx.businessId, ctx.userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function cancel(
  businessId: string,
  id: string,
  userId: string | null,
  reason?: string,
): Promise<boolean> {
  // userId null = staff/owner cancelling any appointment in their tenant.
  const params: unknown[] = [businessId, id, reason || null];
  let userClause = '';
  if (userId) {
    params.push(userId);
    userClause = ` AND user_id = $${params.length}`;
  }
  const { rowCount } = await pool.query(
    `UPDATE appointments
     SET status = 'cancelled', cancellation_reason = $3
     WHERE business_id = $1 AND id = $2${userClause}
       AND status IN ('pending', 'confirmed')`,
    params,
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Services catalogue
// ---------------------------------------------------------------------------

export async function listServices(businessId: string): Promise<ServiceDto[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    duration_minutes: number;
    price_cents: number;
  }>(
    `SELECT id, name, description, duration_minutes, price_cents
     FROM services WHERE business_id = $1 AND is_active ORDER BY name`,
    [businessId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    durationMinutes: r.duration_minutes,
    priceCents: r.price_cents,
  }));
}

/**
 * Resolve a free-text service name to a catalogue row.
 *
 * Used by the AI path, where the user types "whitening" rather than picking a
 * uuid. Matching is done in SQL with a three-tier preference: exact (case
 * insensitive), then the query contained in a name, then a name contained in
 * the query. Returning the whole ranked list lets the service layer distinguish
 * "one clear match" from "ambiguous, ask the user" instead of silently taking
 * the first.
 *
 * Containment uses strpos rather than LIKE on purpose: the query comes from a
 * model or a form, and in a LIKE pattern a "%" or "_" is a wildcard, so
 * "%" would match every service in the catalogue.
 */
export async function matchServiceByName(
  businessId: string,
  query: string,
): Promise<(ServiceDto & { matchRank: number })[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    duration_minutes: number;
    price_cents: number;
    match_rank: number;
  }>(
    `SELECT id, name, description, duration_minutes, price_cents,
            CASE
              WHEN lower(name) = lower($2)             THEN 1
              WHEN strpos(lower(name), lower($2)) > 0  THEN 2
              ELSE 3
            END AS match_rank
     FROM services
     WHERE business_id = $1 AND is_active
       AND (
         strpos(lower(name), lower($2)) > 0
         OR strpos(lower($2), lower(name)) > 0
       )
     ORDER BY match_rank, name
     LIMIT 5`,
    [businessId, query.trim()],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    durationMinutes: r.duration_minutes,
    priceCents: r.price_cents,
    matchRank: r.match_rank,
  }));
}
