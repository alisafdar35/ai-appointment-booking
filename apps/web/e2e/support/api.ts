import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AppointmentDto, AvailabilityDto, ServiceDto, UserDto } from '@appt/shared';

/**
 * Direct API access for arranging and checking state, so each spec drives the
 * UI only for the journey it is about. Every call goes through the web app's
 * own /api proxy, exactly as the browser's would.
 */

/** The seeded tenant every journey books against (db/seed.sql). */
export const BLUEWAVE = { slug: 'bluewave', name: 'Bluewave Dental', timeZone: 'America/New_York' } as const;

export const NEW_USER_PASSWORD = 'Sunflower2026';

export interface Account {
  email: string;
  password: string;
  fullName: string;
}

/** A unique, never-seen-before customer, so no spec inherits another's bookings or conversations. */
export function newAccount(fullName = 'Elena Torres'): Account {
  const tag = randomUUID().slice(0, 8);
  return { email: `e2e.${tag}@example.test`, password: NEW_USER_PASSWORD, fullName };
}

export class ApiClient {
  private constructor(
    private readonly request: APIRequestContext,
    private readonly accessToken: string,
    readonly user: UserDto,
  ) {}

  /** Signs up (joining Bluewave) or signs in, using a request context of the caller's choosing. */
  static async connect(request: APIRequestContext, account: Account, { signUp }: { signUp: boolean }): Promise<ApiClient> {
    const response = signUp
      ? await request.post('/api/auth/signup', {
          data: { ...account, businessSlug: BLUEWAVE.slug },
        })
      : await request.post('/api/auth/login', { data: { email: account.email, password: account.password } });
    expect(response.ok(), `${signUp ? 'sign-up' : 'sign-in'} as ${account.email}`).toBe(true);
    const body = (await response.json()) as { accessToken: string; user: UserDto };
    return new ApiClient(request, body.accessToken, body.user);
  }

  private get headers() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async get<T>(path: string): Promise<T> {
    const response = await this.request.get(path, { headers: this.headers });
    expect(response.ok(), `GET ${path}`).toBe(true);
    return (await response.json()) as T;
  }

  async services(): Promise<ServiceDto[]> {
    return (await this.get<{ services: ServiceDto[] }>('/api/services')).services;
  }

  async service(name: string): Promise<ServiceDto> {
    const found = (await this.services()).find((service) => service.name === name);
    expect(found, `service "${name}" exists`).toBeDefined();
    return found!;
  }

  async freeTimes(serviceId: string, date: string): Promise<string[]> {
    const { availability } = await this.get<{ availability: AvailabilityDto }>(
      `/api/services/${serviceId}/availability?date=${date}`,
    );
    return availability.slots.filter((slot) => slot.available).map((slot) => slot.time);
  }

  async book(input: { serviceId: string; date: string; time: string }): Promise<AppointmentDto> {
    const response = await this.request.post('/api/appointments', {
      headers: this.headers,
      data: { ...input, source: 'form' },
    });
    expect(response.status(), `book ${input.date} ${input.time}`).toBe(201);
    return ((await response.json()) as { appointment: AppointmentDto }).appointment;
  }
}

/**
 * Sign up a fresh customer through the page's own request context, so the
 * browser holds their session cookie, then set the "signed in before" hint the
 * app writes after a real sign-in, for every tab of the context. Returns an API
 * client for the same user.
 */
export async function signUpCustomer(page: Page, account: Account = newAccount()): Promise<ApiClient> {
  const client = await ApiClient.connect(page.request, account, { signUp: true });
  await page.context().addInitScript(() => window.localStorage.setItem('slotly.session', '1'));
  return client;
}

// ---- dates: business days on the business's own calendar ---------------------

/** Today's date on the business's wall clock, as YYYY-MM-DD. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** The next `count` weekdays after `fromIso`, as YYYY-MM-DD. */
export function weekdaysAfter(fromIso: string, count: number): string[] {
  const days: string[] = [];
  const cursor = new Date(`${fromIso}T12:00:00Z`);
  while (days.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Booking days are split into lanes, one per parallel worker slot.
 *
 * Playwright guarantees that tests running at the same time have different
 * `parallelIndex` values, so a test only ever books on its own lane's days and
 * no two concurrent tests can reach for the same slot. Tests that share a lane
 * run one after another, and each reads availability after the previous one
 * booked, so they cannot collide either. Together with a database recreated for
 * every run (scripts/e2e.mjs) that makes slot choice deterministic.
 */
const DAYS_PER_LANE = 3;

/** This worker's booking days: the next weekdays in the business's timezone, `DAYS_PER_LANE` per lane. */
export function laneDays(): string[] {
  const lane = test.info().parallelIndex;
  return weekdaysAfter(todayIn(BLUEWAVE.timeZone), (lane + 1) * DAYS_PER_LANE).slice(lane * DAYS_PER_LANE);
}

export interface OpenSlot {
  service: ServiceDto;
  date: string;
  time: string;
  /** Every free time that day, for specs that need a second choice. */
  freeTimes: string[];
}

const onTheHour = (time: string) => time.endsWith(':00');

/**
 * The earliest free slot on this worker's lane days (see laneDays), read from
 * the live availability endpoint. Times on the hour keep what a spec types
 * plain ("at 2pm").
 */
export async function findOpenSlot(
  api: ApiClient,
  serviceName: string,
  { atLeastFree = 1 }: { atLeastFree?: number } = {},
): Promise<OpenSlot> {
  const service = await api.service(serviceName);
  const days = laneDays();
  for (const date of days) {
    const freeTimes = (await api.freeTimes(service.id, date)).filter(onTheHour);
    if (freeTimes.length >= atLeastFree) return { service, date, time: freeTimes[0]!, freeTimes };
  }
  throw new Error(`No day in this worker's lane (${days.join(', ')}) has ${atLeastFree} free ${serviceName} slot(s)`);
}

/** Another free time on the slot's day, for specs that change or lose the first choice. */
export function otherFreeTime(slot: OpenSlot): string {
  const other = slot.freeTimes.find((time) => time !== slot.time);
  expect(other, `a second free time on ${slot.date}`).toBeDefined();
  return other!;
}

// ---- how the UI writes dates and times -----------------------------------------

/** "2026-10-07" -> "October 7", the way a person types it. */
export function spokenDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** "2026-10-07" -> "Wednesday, October 7, 2026", as the cards print it. */
export function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "14:00" -> "2:00 PM", as the cards and slot pickers print it. */
export function clockTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** "14:00" -> "2pm", the way a person types it. */
export function spokenTime(time: string): string {
  const hours = Number(time.slice(0, 2));
  return `${hours % 12 || 12}${hours < 12 ? 'am' : 'pm'}`;
}
