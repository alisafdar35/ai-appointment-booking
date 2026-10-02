import { todayInZone } from '../../src/lib/time.js';

/** Identifiers from db/seed.sql. Fixed UUIDs, so tests can refer to them by name. */
export const SEED = {
  password: 'Password123!',
  bluewave: {
    id: '11111111-1111-1111-1111-111111111111',
    slug: 'bluewave',
    timezone: 'America/New_York',
    opensAt: '09:00',
    closesAt: '17:00',
  },
  northside: {
    id: '22222222-2222-2222-2222-222222222222',
    slug: 'northside',
    timezone: 'Europe/London',
    opensAt: '08:00',
    closesAt: '18:00',
  },
  users: {
    owner: { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'owner@bluewave.test', role: 'owner' },
    customer: { id: 'aaaaaaaa-0000-0000-0000-000000000002', email: 'customer@bluewave.test', role: 'customer' },
    staff: { id: 'aaaaaaaa-0000-0000-0000-000000000003', email: 'staff@bluewave.test', role: 'staff' },
    northsideOwner: { id: 'bbbbbbbb-0000-0000-0000-000000000001', email: 'owner@northside.test', role: 'owner' },
  },
  services: {
    routineCheckup: { id: 'cccccccc-0000-0000-0000-000000000001', name: 'Routine Checkup', durationMinutes: 30 },
    teethWhitening: { id: 'cccccccc-0000-0000-0000-000000000002', name: 'Teeth Whitening', durationMinutes: 60 },
    emergencyConsult: { id: 'cccccccc-0000-0000-0000-000000000003', name: 'Emergency Consult', durationMinutes: 20 },
    orthodonticReview: { id: 'cccccccc-0000-0000-0000-000000000004', name: 'Orthodontic Review', durationMinutes: 45 },
    generalPractice: { id: 'dddddddd-0000-0000-0000-000000000001', name: 'General Practice', durationMinutes: 15 },
  },
} as const;

export type SeededUser = keyof typeof SEED.users;

/** Add whole days to a YYYY-MM-DD date. Pure calendar arithmetic, no timezone involved. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A date `daysAhead` from now in the given business timezone.
 *
 * Tests never hard-code calendar dates: the seed anchors its appointments to
 * `now()`, and a fixed date would silently turn into "in the past" the day the
 * suite outlives it. Offsets of 10+ days stay clear of the seeded bookings.
 */
export function futureDate(daysAhead: number, timeZone: string = SEED.bluewave.timezone): string {
  return addDays(todayInZone(timeZone), daysAhead);
}

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** The first date on or after `from` that falls on the given weekday (0 = Sunday). */
export function nextWeekday(from: string, day: number): string {
  return addDays(from, (day - weekday(from) + 7) % 7);
}

/** [month, day] after which the transition Sunday falls: the first Sunday on or after it. */
const DST_RULES = {
  // US: second Sunday of March, first Sunday of November.
  'America/New_York': { spring: [3, 8], fall: [11, 1] },
  // UK: last Sunday of March and of October (the Sunday on or after the 25th).
  'Europe/London': { spring: [3, 25], fall: [10, 25] },
} as const;

/**
 * The next DST transition date that is still comfortably in the future.
 *
 * Transition days are where timezone code goes wrong: the local day is 23 or 25
 * hours long and the UTC offset changes mid-day. The rules are stable, so the
 * date is derived rather than pinned, which keeps the tests valid in any year
 * instead of expiring when a hard-coded date slips into the past.
 */
export function nextDstTransition(timeZone: keyof typeof DST_RULES, kind: 'spring' | 'fall'): string {
  const today = todayInZone(timeZone);
  const year = Number(today.slice(0, 4));
  const [month, day] = DST_RULES[timeZone][kind];
  for (const y of [year, year + 1]) {
    const candidate = nextWeekday(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, 0);
    // A day of margin, so slots earlier "today" never skew the result.
    if (candidate > addDays(today, 1)) return candidate;
  }
  throw new Error('unreachable: one of two consecutive years always has a future transition');
}

let nextOffset = 10;

/**
 * A date no other test in this file has used, in the business timezone.
 *
 * Tests in a file share one seeded database, so each booking test claims its
 * own day instead of fighting over a slot. The counter starts at 10 to stay
 * clear of the seed's bookings (3 and 5 days out).
 */
export function freshDate(timeZone: string = SEED.bluewave.timezone): string {
  return futureDate(nextOffset++, timeZone);
}
