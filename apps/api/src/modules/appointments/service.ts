import type { AppointmentDto, CreateAppointmentInput, ListAppointmentsInput } from '@appt/shared';
import { withTransaction } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import {
  OVERLAP_CONSTRAINTS,
  PG_ERRORS,
  appointmentInPast,
  appointmentNotCancellable,
  badRequest,
  customerBusy,
  isPgError,
  notFound,
  outsideBusinessHours,
  pgConstraint,
  slotUnavailable,
} from '../../lib/errors.js';
import { humanTime, shortDate } from '../../lib/time.js';
import * as repo from './repository.js';
import { checkSlot, suggestAlternatives } from './availability.js';

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
  code: 'service_not_found' | 'in_past' | 'outside_hours' | 'off_grid' | 'taken' | 'customer_busy';
  message: string;
  suggestions?: { date: string; time: string; label: string }[];
}
export type BookingResult = { ok: true; appointment: AppointmentDto } | BookingFailure;

/** Nearby free times for a slot that was refused, labelled for display. */
async function alternativesTo(
  ctx: BookingContext,
  requested: CreateAppointmentInput,
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

/**
 * Attempt a booking, returning a result rather than throwing.
 *
 * The conversational flow needs to *talk about* a failure ("that one's taken,
 * how about 3pm?"), not catch an exception. Routes that want HTTP semantics
 * call createAppointmentOrThrow below, which converts the same result into the
 * right status code — so both surfaces share one implementation of the rules.
 */
export async function attemptBooking(
  ctx: BookingContext,
  input: CreateAppointmentInput,
): Promise<BookingResult> {
  const check = await checkSlot(ctx.businessId, input.serviceId, input.date, input.time, ctx.userId);

  if (!check.ok) {
    switch (check.reason) {
      case 'service_not_found':
        return { ok: false, code: 'service_not_found', message: 'That service is not available.' };
      case 'in_past':
        return {
          ok: false,
          code: 'in_past',
          message: 'That time has already passed. Please pick a future time.',
        };
      case 'outside_hours':
        return {
          ok: false,
          code: 'outside_hours',
          message: `We're open ${humanTime(check.opensAt)} to ${humanTime(check.closesAt)}. Please choose a time inside those hours.`,
        };
      case 'off_grid':
        return {
          ok: false,
          code: 'off_grid',
          message: 'Appointments start on the hour or half hour.',
          suggestions: await alternativesTo(ctx, input),
        };
      case 'taken':
        return {
          ok: false,
          code: 'taken',
          message: 'That slot is already booked.',
          suggestions: await alternativesTo(ctx, input),
        };
      case 'customer_busy':
        return {
          ok: false,
          code: 'customer_busy',
          message: 'You already have an appointment at that time.',
          suggestions: await alternativesTo(ctx, input),
        };
    }
  }

  try {
    const appointment = await withTransaction(async (client) => {
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
    });

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
      return {
        ok: false,
        code: customerClash ? 'customer_busy' : 'taken',
        message: customerClash
          ? 'You already have an appointment at that time.'
          : 'Someone just took that slot. Please pick another.',
        suggestions: await alternativesTo(ctx, input),
      };
    }
    throw err;
  }
}

/**
 * HTTP-facing wrapper: the same rules, surfaced as status codes.
 *
 * It also checks the claim the client makes about a booking's provenance. The
 * chat service sets it from state it has already verified, so this only needs
 * to hold for a request that arrives over the wire. (The other claim, `source`,
 * is limited by the schema to 'chat' or 'form'.)
 */
export async function createAppointmentOrThrow(
  ctx: BookingContext & { role: string },
  input: CreateAppointmentInput,
): Promise<AppointmentDto> {
  // The column is a plain foreign key, so without this check a booking could be
  // attached to a conversation that belongs to someone else — in any tenant.
  if (input.chatSessionId && !(await repo.ownsChatSession(ctx, input.chatSessionId))) {
    throw notFound('Conversation');
  }

  const result = await attemptBooking(ctx, input);
  if (result.ok) return result.appointment;

  switch (result.code) {
    case 'service_not_found':
      throw notFound('Service');
    case 'in_past':
      throw appointmentInPast();
    case 'outside_hours':
      throw outsideBusinessHours(result.message);
    case 'off_grid':
      // A field error, so a form can point at the time input.
      throw badRequest(result.message, { time: [result.message] });
    case 'taken':
      throw slotUnavailable(result.message);
    case 'customer_busy':
      throw customerBusy(result.message);
  }
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
