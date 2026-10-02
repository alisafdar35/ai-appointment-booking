import type { AppointmentDto, CreateAppointmentInput, ListAppointmentsInput } from '@appt/shared';
import { withTransaction, type Queryable } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import {
  CHAT_SESSION_BOOKING_INDEX,
  OVERLAP_CONSTRAINTS,
  PG_ERRORS,
  appointmentInPast,
  appointmentNotCancellable,
  badRequest,
  customerBusy,
  idempotencyKeyReused,
  isPgError,
  notFound,
  outsideBusinessHours,
  pgConstraint,
  sessionClosed,
  slotUnavailable,
} from '../../lib/errors.js';
import { humanTime, shortDate } from '../../lib/time.js';
import * as repo from './repository.js';
import { checkSlot, suggestAlternatives, type SlotCheck } from './availability.js';
import * as idempotency from './idempotency.js';

/**
 * Booking business logic.
 *
 * This is the ONLY way an appointment gets created, whichever surface the
 * request came from. The structured form calls it; the chatbot calls it with
 * `source: 'chat'` after the AI layer has produced slots. The AI code never
 * writes to the database and never re-implements a rule — it extracts
 * information, and this service decides whether a booking is allowed.
 *
 * That boundary is deliberate. If the LLM could book directly, every rule here
 * (business hours, past times, double-booking, tenant scope) would depend on a
 * model following instructions. Here they depend on code and a constraint.
 */

export interface BookingContext {
  businessId: string;
  userId: string;
}

export interface BookingFailure {
  ok: false;
  code:
    | 'service_not_found'
    | 'in_past'
    | 'closed_day'
    | 'nonexistent_time'
    | 'outside_hours'
    | 'off_grid'
    | 'taken'
    | 'customer_busy';
  message: string;
  suggestions?: { date: string; time: string; label: string }[];
}
export type BookingResult = { ok: true; appointment: AppointmentDto } | BookingFailure;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** ISO weekdays as a sentence fragment: [1..5] -> "Monday to Friday", [2, 4] -> "Tuesday and Thursday". */
function describeDays(isoDays: number[]): string {
  const days = [...new Set(isoDays)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < days.length; ) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j]! + 1) j += 1;
    const [from, to] = [WEEKDAYS[days[i]! - 1]!, WEEKDAYS[days[j]! - 1]!];
    // A run of three or more reads as a range; two adjacent days read better listed.
    if (j - i >= 2) runs.push(`${from} to ${to}`);
    else runs.push(...days.slice(i, j + 1).map((d) => WEEKDAYS[d - 1]!));
    i = j + 1;
  }
  return runs.length > 1 ? `${runs.slice(0, -1).join(', ')} and ${runs.at(-1)}` : runs[0]!;
}

/** The weekday of a YYYY-MM-DD calendar date. Pure calendar arithmetic, no timezone. */
const weekdayOf = (date: string): string => WEEKDAYS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7]!;

type RequestedSlot = Pick<CreateAppointmentInput, 'serviceId' | 'date' | 'time'>;

/** Nearby free times for a slot that was refused, labelled for display. */
async function alternativesTo(
  ctx: BookingContext,
  requested: RequestedSlot,
): Promise<NonNullable<BookingFailure['suggestions']>> {
  const alternatives = await suggestAlternatives(
    ctx.businessId,
    requested.serviceId,
    ctx.userId,
    requested.date,
    requested.time,
  );
  return alternatives.map((a) => ({
    ...a,
    // Same day as asked: the time alone is clear. Another day names the day.
    label: a.date === requested.date ? humanTime(a.time) : `${shortDate(a.date)}, ${humanTime(a.time)}`,
  }));
}

interface CheckOptions {
  /** Run inside the caller's transaction instead of opening one. */
  client?: Queryable;
  /** Look up alternative times for a refusal. The HTTP path does not return them. */
  suggest?: boolean;
}

/**
 * Refusals answered with nearby free times. For the others (a past time,
 * outside opening hours, a missing service) another slot on the grid is not
 * what the user needs to hear first.
 */
const OFFERS_ALTERNATIVES = new Set<BookingFailure['code']>([
  'closed_day',
  'nonexistent_time',
  'off_grid',
  'taken',
  'customer_busy',
]);

async function withAlternatives(
  ctx: BookingContext,
  input: RequestedSlot,
  failure: BookingFailure,
): Promise<BookingFailure> {
  return OFFERS_ALTERNATIVES.has(failure.code) ? { ...failure, suggestions: await alternativesTo(ctx, input) } : failure;
}

/** The user-facing refusal for a failed slot check. */
function refusalFor(input: RequestedSlot, check: Exclude<SlotCheck, { ok: true }>): BookingFailure {
  switch (check.reason) {
    case 'service_not_found':
      return { ok: false, code: 'service_not_found', message: 'That service is not available.' };
    case 'in_past':
      return { ok: false, code: 'in_past', message: 'That time has already passed. Please pick a future time.' };
    case 'closed_day':
      return {
        ok: false,
        code: 'closed_day',
        message: `We're closed on ${weekdayOf(input.date)}s. We take bookings ${describeDays(check.openDays)}.`,
      };
    case 'nonexistent_time':
      return {
        ok: false,
        code: 'nonexistent_time',
        message: `${humanTime(input.time)} does not exist on ${shortDate(input.date)}: the clocks go forward then. Please pick another time.`,
      };
    case 'outside_hours':
      return {
        ok: false,
        code: 'outside_hours',
        message: `We're open ${humanTime(check.opensAt)} to ${humanTime(check.closesAt)}. Please choose a time inside those hours.`,
      };
    case 'off_grid':
      return { ok: false, code: 'off_grid', message: 'Appointments start on the hour or half hour.' };
    case 'taken':
      return { ok: false, code: 'taken', message: 'That slot is already booked.' };
    case 'customer_busy':
      return { ok: false, code: 'customer_busy', message: 'You already have an appointment at that time.' };
  }
}

/**
 * Would this booking be refused right now, and if so, why? Every rule
 * attemptBooking applies, with the same refusal (message and suggestions), and
 * nothing written: null means it would be accepted at this moment.
 *
 * The chat calls it before showing a summary, so a "yes" is never invited for
 * a slot that can only be turned down. It is advice, not a reservation —
 * attemptBooking checks again, and the constraints arbitrate any race.
 */
export async function checkBooking(
  ctx: BookingContext,
  input: RequestedSlot,
  options: CheckOptions = {},
): Promise<BookingFailure | null> {
  const check = await checkSlot(ctx.businessId, input.serviceId, input.date, input.time, ctx.userId, options.client);
  if (check.ok) return null;
  const failure = refusalFor(input, check);
  return options.suggest === false ? failure : withAlternatives(ctx, input, failure);
}

/**
 * Attempt a booking, returning a result rather than throwing.
 *
 * The conversational flow needs to *talk about* a failure ("that one's taken,
 * how about 3pm?"), not catch an exception. Routes that want HTTP semantics
 * call createAppointmentOrThrow below, which converts the same result into the
 * right status code — so both surfaces share one implementation of the rules.
 *
 * A booking that names a conversation goes through bookInSession, whichever
 * route it came from. Throws 404 for a conversation that is not the caller's
 * and 409 SESSION_CLOSED for one that has already booked.
 */
export async function attemptBooking(
  ctx: BookingContext,
  input: CreateAppointmentInput,
  options: CheckOptions = {},
): Promise<BookingResult> {
  if (!input.chatSessionId) return book(ctx, input, options);

  const sessionId = input.chatSessionId;
  const locked = (client: Queryable) => bookInSession(ctx, { ...input, chatSessionId: sessionId }, client);
  const result = options.client ? await locked(options.client) : await withTransaction(locked);
  // Alternatives are looked up once the row lock is released: every request
  // queued on it holds a pooled connection, and the lookup needs another.
  return result.ok || options.suggest === false ? result : withAlternatives(ctx, input, result);
}

/**
 * One booking per conversation, enforced in the database so it holds across
 * every route and every API instance (the chat's turn queue is per process,
 * and the form route never used it). The session row is locked for the whole
 * check-and-insert: a second booking for the same conversation — a chat "yes"
 * racing the form, a double submit — waits here, then finds it completed.
 * The unique index from migration 009 backs this up.
 */
async function bookInSession(
  ctx: BookingContext,
  input: CreateAppointmentInput & { chatSessionId: string },
  client: Queryable,
): Promise<BookingResult> {
  // Scoped to the caller: the column is a plain foreign key, so without this a
  // booking could be attached to someone else's conversation, in any tenant.
  const status = await repo.lockChatSession(client, ctx, input.chatSessionId);
  if (!status) throw notFound('Conversation');
  if (status !== 'active') throw sessionClosed();

  const result = await book(ctx, input, { client, suggest: false });
  if (result.ok) await repo.completeChatSession(client, input.chatSessionId);
  return result;
}

/** Check the rules and insert, in `options.client`'s transaction or a new one. */
async function book(ctx: BookingContext, input: CreateAppointmentInput, options: CheckOptions): Promise<BookingResult> {
  const refused = await checkBooking(ctx, input, options);
  if (refused) return refused;

  const insert = async (client: Queryable) => {
    const id = await repo.create(client, {
      businessId: ctx.businessId,
      userId: ctx.userId,
      serviceId: input.serviceId,
      date: input.date,
      time: input.time,
      notes: input.notes,
      source: input.source,
      chatSessionId: input.chatSessionId,
    });
    if (!id) return null;
    const created = await repo.findById(ctx.businessId, id, client);
    if (!created) throw new Error('Appointment vanished immediately after insert');
    return created;
  };

  try {
    const appointment = options.client ? await insert(options.client) : await withTransaction(insert);

    if (!appointment) {
      // The service was deactivated between checkSlot and the insert.
      return { ok: false, code: 'service_not_found', message: 'That service is not available.' };
    }
    logger.info(
      {
        appointmentId: appointment.id,
        userId: ctx.userId,
        businessId: ctx.businessId,
        source: input.source,
      },
      'Appointment created',
    );
    return { ok: true, appointment };
  } catch (err) {
    // An EXCLUDE constraint refused the row. Getting here means two requests
    // passed checkSlot concurrently and the database arbitrated — which is
    // exactly why the constraints exist. checkSlot is an optimisation that lets
    // us give a good message cheaply; the constraints are the guarantee.
    if (isPgError(err, PG_ERRORS.EXCLUSION_VIOLATION)) {
      const customerClash = pgConstraint(err) === OVERLAP_CONSTRAINTS.CUSTOMER;
      logger.warn(
        { userId: ctx.userId, input, constraint: pgConstraint(err) },
        'Booking lost a race; EXCLUDE constraint held',
      );
      const failure: BookingFailure = {
        ok: false,
        code: customerClash ? 'customer_busy' : 'taken',
        message: customerClash
          ? 'You already have an appointment at that time.'
          : 'Someone just took that slot. Please pick another.',
      };
      return options.suggest === false ? failure : withAlternatives(ctx, input, failure);
    }
    // Only reachable past the session lock by a writer that skipped it.
    if (isPgError(err, PG_ERRORS.UNIQUE_VIOLATION) && pgConstraint(err) === CHAT_SESSION_BOOKING_INDEX) {
      throw sessionClosed();
    }
    throw err;
  }
}

/**
 * HTTP-facing wrapper: the same rules, surfaced as status codes.
 *
 * The claim a client makes about a booking's provenance, `chatSessionId`, is
 * checked by attemptBooking (bookInSession). The other claim, `source`, is
 * limited by the schema to 'chat' or 'form'.
 */
export async function createAppointmentOrThrow(
  ctx: BookingContext & { role: string },
  input: CreateAppointmentInput,
  client?: Queryable,
): Promise<AppointmentDto> {
  const result = await attemptBooking(ctx, input, { suggest: false, ...(client ? { client } : {}) });
  if (result.ok) return result.appointment;

  switch (result.code) {
    case 'service_not_found':
      throw notFound('Service');
    case 'in_past':
      throw appointmentInPast();
    case 'closed_day':
    case 'outside_hours':
      throw outsideBusinessHours(result.message);
    case 'off_grid':
    case 'nonexistent_time':
      // Field errors, so a form can point at the time input.
      throw badRequest(result.message, { time: [result.message] });
    case 'taken':
      throw slotUnavailable(result.message);
    case 'customer_busy':
      throw customerBusy(result.message);
  }
}

/**
 * createAppointmentOrThrow behind an Idempotency-Key (see idempotency.ts).
 *
 * The key is claimed, the booking made and the response stored in one
 * transaction. A refusal throws, which rolls the claim back with it, so only
 * a successful booking ever occupies a key. `replayed` is the stored 201 body
 * of the request that first used the key.
 */
export async function createAppointmentIdempotent(
  ctx: BookingContext & { role: string },
  input: CreateAppointmentInput,
  key: string,
): Promise<{ replayed: false; appointment: AppointmentDto } | { replayed: true; body: unknown }> {
  const hash = idempotency.fingerprint(input);
  return withTransaction(async (client) => {
    if (!(await idempotency.claim(client, ctx, key, hash))) {
      const stored = await idempotency.find(client, ctx, key);
      if (!stored.requestHash.equals(hash)) throw idempotencyKeyReused();
      logger.info({ userId: ctx.userId, key }, 'Idempotent booking replayed');
      return { replayed: true, body: stored.response };
    }
    const appointment = await createAppointmentOrThrow(ctx, input, client);
    await idempotency.saveResponse(client, ctx, key, appointment.id, { appointment });
    return { replayed: false, appointment };
  });
}

export async function listAppointments(
  ctx: BookingContext & { role: string },
  filters: ListAppointmentsInput,
): Promise<AppointmentDto[]> {
  // Customers see only their own bookings; owners and staff see the tenant's.
  return repo.list(ctx.businessId, filters, ctx.role === 'customer' ? ctx.userId : undefined);
}

export async function getAppointment(
  ctx: BookingContext & { role: string },
  id: string,
): Promise<AppointmentDto> {
  const appointment = await repo.findById(ctx.businessId, id);
  if (!appointment) throw notFound('Appointment');
  // Tenant scope is already enforced by the query; this is the per-user check.
  if (ctx.role === 'customer' && appointment.customer.id !== ctx.userId) throw notFound('Appointment');
  return appointment;
}

export async function cancelAppointment(
  ctx: BookingContext & { role: string },
  id: string,
  reason?: string,
): Promise<AppointmentDto> {
  const scopeToUser = ctx.role === 'customer' ? ctx.userId : null;
  const cancelled = await repo.cancel(ctx.businessId, id, scopeToUser, reason);

  if (!cancelled) {
    // Either it does not exist for this caller, or it is already in a terminal
    // state. Distinguish so the user gets a useful message — but only about
    // their own appointments: a customer pointing at someone else's gets the
    // same 404 as for an id that does not exist, not a status report.
    const existing = await repo.findById(ctx.businessId, id);
    if (!existing || (scopeToUser && existing.customer.id !== scopeToUser)) throw notFound('Appointment');
    throw appointmentNotCancellable(existing.status);
  }

  logger.info({ appointmentId: id, userId: ctx.userId }, 'Appointment cancelled');
  const updated = await repo.findById(ctx.businessId, id);
  if (!updated) throw notFound('Appointment');
  return updated;
}

export const listServices = repo.listServices;
export const listForChatSession = repo.listForChatSession;
export const matchServiceByName = repo.matchServiceByName;
