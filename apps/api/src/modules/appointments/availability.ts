import { SLOT_GRID_MINUTES, type AvailabilityDto } from '@appt/shared';
import { pool, type Queryable } from '../../db/pool.js';

/**
 * A day's start times on the SLOT_GRID_MINUTES grid, each marked free or not,
 * in one SQL statement: the overlap test uses the same GIST index as the
 * EXCLUDE constraints, so "is this free?" and "is this allowed?" never
 * disagree, and hours/timezone/booked set never leave the database.
 * `customerId`'s own live bookings (any service) also block a time, since
 * offering it would only meet the customer-overlap refusal.
 */
export async function getAvailability(
  businessId: string,
  serviceId: string,
  date: string,
  customerId: string | null = null,
): Promise<AvailabilityDto | null> {
  const { rows } = await pool.query<{
    duration_minutes: number;
    is_open: boolean;
    slots: { time: string; available: boolean }[];
  }>(
    `WITH day AS (
       SELECT b.timezone, b.opens_at, b.closes_at, s.duration_minutes,
              EXTRACT(ISODOW FROM $3::date)::smallint = ANY (b.open_days) AS is_open
       FROM businesses b
       JOIN services s ON s.business_id = b.id AND s.id = $2 AND s.is_active
       WHERE b.id = $1
     ),
     -- Candidate start times on the grid, stopping early enough that the
     -- service still finishes before closing. None on a day the business is
     -- closed, and none for a wall time a spring-forward transition skips:
     -- such a time has no instant, and round-tripping it through the zone
     -- exposes that (see checkSlot).
     candidates AS (
       SELECT gs AS local_start, gs AT TIME ZONE day.timezone AS abs_start
       FROM day,
            generate_series(
              ($3::date + day.opens_at)::timestamp,
              ($3::date + day.closes_at)::timestamp - make_interval(mins => day.duration_minutes),
              make_interval(mins => $4::int)
            ) AS gs
       WHERE day.is_open
         AND (gs AT TIME ZONE day.timezone) AT TIME ZONE day.timezone = gs
     )
     SELECT
       day.duration_minutes,
       day.is_open,
       COALESCE((
         SELECT json_agg(json_build_object(
                  'time', to_char(c.local_start, 'HH24:MI'),
                  'available',
                  -- Not already in the past...
                  c.abs_start > now()
                  -- ...and not overlapping a live appointment for this service,
                  -- or one the customer already holds for any service.
                  AND NOT EXISTS (
                    SELECT 1 FROM appointments a
                    WHERE a.business_id = $1
                      AND (a.service_id = $2 OR a.user_id = $5)
                      AND a.status IN ('pending', 'confirmed')
                      AND a.slot && tstzrange(
                            c.abs_start,
                            c.abs_start + make_interval(mins => day.duration_minutes),
                            '[)')
                  )
                ) ORDER BY c.local_start)
         FROM candidates c
       ), '[]'::json) AS slots
     FROM day`,
    [businessId, serviceId, date, SLOT_GRID_MINUTES, customerId],
  );

  // No row means the service does not exist in this tenant, or is inactive.
  const row = rows[0];
  if (!row) return null;

  return {
    date,
    serviceId,
    durationMinutes: row.duration_minutes,
    closed: !row.is_open,
    slots: row.slots,
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
  | { ok: false; reason: 'closed_day'; openDays: number[] }
  | { ok: false; reason: 'nonexistent_time' }
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
  client: Queryable = pool,
): Promise<SlotCheck> {
  const { rows } = await client.query<{
    duration_minutes: number;
    in_past: boolean;
    is_open: boolean;
    open_days: number[];
    exists_locally: boolean;
    within_hours: boolean;
    taken: boolean;
    customer_busy: boolean;
    opens_at: string;
    closes_at: string;
  }>(
    `WITH biz AS (
       SELECT timezone, opens_at, closes_at, open_days FROM businesses WHERE id = $1
     ),
     svc AS (
       SELECT duration_minutes FROM services
       WHERE business_id = $1 AND id = $2 AND is_active
     ),
     req AS (
       SELECT
         svc.duration_minutes,
         biz.timezone, biz.opens_at, biz.closes_at, biz.open_days,
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
       EXTRACT(ISODOW FROM r.local_start)::smallint = ANY (r.open_days) AS is_open,
       r.open_days::int[] AS open_days,
       -- Postgres resolves a wall time inside a spring-forward gap (02:30 on a
       -- US transition day) by shifting it an hour, so it would quietly book
       -- 03:30. Converting the instant back exposes the shift: the time does
       -- not exist that day. A repeated fall-back time (01:30) round-trips
       -- fine, and Postgres takes its second occurrence, standard time; the
       -- availability grid uses the same conversion, so the two agree.
       (r.abs_start AT TIME ZONE r.timezone) = r.local_start AS exists_locally,
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
  if (!row.is_open) return { ok: false, reason: 'closed_day', openDays: row.open_days };
  if (!row.exists_locally) return { ok: false, reason: 'nonexistent_time' };
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
