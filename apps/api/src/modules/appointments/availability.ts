import { SLOT_GRID_MINUTES, type AvailabilityDto } from '@appt/shared';
import { pool } from '../../db/pool.js';

/**
 * Availability.
 *
 * Computed in a single SQL statement rather than by loading the day's
 * appointments into Node and looping. Three reasons:
 *   - the overlap test reuses the same GIST index that backs the
 *     appointments_no_overlap constraint, so "is this free?" and "is this
 *     allowed?" can never disagree;
 *   - business hours, timezone conversion and the booked set are all already
 *     in the database, so no round trip has to move them out and back;
 *   - it stays one query as the booked set grows.
 *
 * Candidate start times are on the SLOT_GRID_MINUTES grid (@appt/shared)
 * regardless of service length. A service longer than the grid simply occupies
 * several grid positions, and the overlap check marks the covered ones
 * unavailable.
 *
 * `customerId` is who the booking would be for. Their own live appointments
 * (for any service) also mark a time unavailable: offering it would only lead
 * to the appointments_customer_no_overlap refusal. Every booking is made for
 * the caller, so the routes pass the caller's id.
 */
export async function getAvailability(
  businessId: string,
  serviceId: string,
  date: string,
  customerId: string | null = null,
): Promise<AvailabilityDto | null> {
  const { rows } = await pool.query<{
    time: string;
    available: boolean;
    duration_minutes: number;
  }>(
    `WITH biz AS (
       SELECT timezone, opens_at, closes_at FROM businesses WHERE id = $1
     ),
     svc AS (
       SELECT duration_minutes FROM services
       WHERE business_id = $1 AND id = $2 AND is_active
     ),
     -- Candidate start times on the grid, stopping early enough that the
     -- service still finishes before closing.
     candidates AS (
       SELECT gs AS local_start, svc.duration_minutes
       FROM biz, svc,
            generate_series(
              ($3::date + biz.opens_at)::timestamp,
              ($3::date + biz.closes_at)::timestamp - make_interval(mins => svc.duration_minutes),
              make_interval(mins => $4::int)
            ) AS gs
     )
     SELECT
       to_char(c.local_start, 'HH24:MI') AS time,
       c.duration_minutes,
       (
         -- Not already in the past...
         (c.local_start AT TIME ZONE biz.timezone) > now()
         -- ...and not overlapping a live appointment for this service, or
         -- one the customer already holds for any service.
         AND NOT EXISTS (
           SELECT 1 FROM appointments a
           WHERE a.business_id = $1
             AND (a.service_id = $2 OR a.user_id = $5)
             AND a.status IN ('pending', 'confirmed')
             AND a.slot && tstzrange(
                   c.local_start AT TIME ZONE biz.timezone,
                   (c.local_start AT TIME ZONE biz.timezone)
                     + make_interval(mins => c.duration_minutes),
                   '[)')
         )
       ) AS available
     FROM candidates c, biz
     ORDER BY c.local_start`,
    [businessId, serviceId, date, SLOT_GRID_MINUTES, customerId],
  );

  // Empty means the service does not exist in this tenant, or is inactive.
  if (rows.length === 0) return null;

  return {
    date,
    serviceId,
    durationMinutes: rows[0]!.duration_minutes,
    slots: rows.map((r) => ({ time: r.time, available: r.available })),
  };
}

/**
 * Is one specific slot bookable, and if not, why?
 *
 * Returns a discriminated reason rather than a boolean so the caller can give
 * the user something actionable — "we close at 5" reads very differently from
 * "that one is taken", and the chatbot needs to say the right one.
 */
export type SlotCheck =
  | { ok: true; durationMinutes: number }
  | { ok: false; reason: 'service_not_found' }
  | { ok: false; reason: 'in_past' }
  | { ok: false; reason: 'outside_hours'; opensAt: string; closesAt: string }
  | { ok: false; reason: 'off_grid' }
  | { ok: false; reason: 'taken' }
  | { ok: false; reason: 'customer_busy' };

const onGrid = (hhmm: string): boolean => toMinutes(hhmm) % SLOT_GRID_MINUTES === 0;

export async function checkSlot(
  businessId: string,
  serviceId: string,
  date: string,
  time: string,
  customerId: string,
): Promise<SlotCheck> {
  const { rows } = await pool.query<{
    duration_minutes: number;
    in_past: boolean;
    within_hours: boolean;
    taken: boolean;
    customer_busy: boolean;
    opens_at: string;
    closes_at: string;
  }>(
    `WITH biz AS (
       SELECT timezone, opens_at, closes_at FROM businesses WHERE id = $1
     ),
     svc AS (
       SELECT duration_minutes FROM services
       WHERE business_id = $1 AND id = $2 AND is_active
     ),
     req AS (
       SELECT
         svc.duration_minutes,
         biz.opens_at, biz.closes_at,
         ($3 || ' ' || $4)::timestamp AS local_start,
         (($3 || ' ' || $4)::timestamp) AT TIME ZONE biz.timezone AS abs_start,
         ((($3 || ' ' || $4)::timestamp) AT TIME ZONE biz.timezone)
           + make_interval(mins => svc.duration_minutes) AS abs_end
       FROM biz, svc
     )
     SELECT
       r.duration_minutes,
       to_char(r.opens_at,  'HH24:MI') AS opens_at,
       to_char(r.closes_at, 'HH24:MI') AS closes_at,
       (r.abs_start <= now()) AS in_past,
       -- The whole appointment must fit inside opening hours, not just its start.
       (r.local_start::time >= r.opens_at
        AND (r.local_start + make_interval(mins => r.duration_minutes))::time <= r.closes_at
        -- Guard against a duration that would push the end past midnight.
        AND (r.local_start + make_interval(mins => r.duration_minutes))::date = r.local_start::date
       ) AS within_hours,
       EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.business_id = $1 AND a.service_id = $2
           AND a.status IN ('pending', 'confirmed')
           AND a.slot && tstzrange(r.abs_start, r.abs_end, '[)')
       ) AS taken,
       EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.business_id = $1 AND a.user_id = $5
           AND a.status IN ('pending', 'confirmed')
           AND a.slot && tstzrange(r.abs_start, r.abs_end, '[)')
       ) AS customer_busy
     FROM req r`,
    [businessId, serviceId, date, time, customerId],
  );

  const row = rows[0];
  if (!row) return { ok: false, reason: 'service_not_found' };
  if (row.in_past) return { ok: false, reason: 'in_past' };
  if (!row.within_hours) {
    return { ok: false, reason: 'outside_hours', opensAt: row.opens_at, closesAt: row.closes_at };
  }
  if (!onGrid(time)) return { ok: false, reason: 'off_grid' };
  if (row.taken) return { ok: false, reason: 'taken' };
  if (row.customer_busy) return { ok: false, reason: 'customer_busy' };
  return { ok: true, durationMinutes: row.duration_minutes };
}

/**
 * Nearest alternative times when the requested slot is gone.
 *
 * Looks at the requested day first and then the following few days, because
 * "nothing left today, here is tomorrow morning" is a far better answer than
 * "unavailable". The chatbot turns these straight into tappable suggestions.
 */
export async function suggestAlternatives(
  businessId: string,
  serviceId: string,
  customerId: string,
  date: string,
  preferredTime: string,
  limit = 3,
): Promise<{ date: string; time: string }[]> {
  const suggestions: { date: string; time: string }[] = [];
  const start = new Date(`${date}T00:00:00Z`);

  for (let dayOffset = 0; dayOffset < 5 && suggestions.length < limit; dayOffset += 1) {
    const day = new Date(start.getTime() + dayOffset * 86_400_000).toISOString().slice(0, 10);
    const availability = await getAvailability(businessId, serviceId, day, customerId);
    if (!availability) break;

    const free = availability.slots.filter((s) => s.available);
    // On the requested day, prefer times closest to what the user asked for.
    if (dayOffset === 0) {
      const target = toMinutes(preferredTime);
      free.sort((a, b) => Math.abs(toMinutes(a.time) - target) - Math.abs(toMinutes(b.time) - target));
    }
    for (const slot of free) {
      if (suggestions.length >= limit) break;
      suggestions.push({ date: day, time: slot.time });
    }
  }
  return suggestions;
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
