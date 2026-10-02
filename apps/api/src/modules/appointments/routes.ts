import { Router } from 'express';
import { z } from 'zod';
import {
  availabilitySchema,
  cancelAppointmentSchema,
  createAppointmentSchema,
  listAppointmentsSchema,
} from '@appt/shared';
import { notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { getAvailability } from './availability.js';
import * as service from './service.js';
import { emitAppointmentCreated, emitAppointmentUpdated } from '../../realtime/index.js';

export const appointmentsRouter = Router();

// Every route below requires a session. Mounted once rather than repeated per
// route, so a new endpoint cannot be added unprotected by omission.
appointmentsRouter.use(requireAuth);

const ctxFrom = (req: { auth?: { sub: string; bid: string; role: string } }) => ({
  businessId: req.auth!.bid,
  userId: req.auth!.sub,
  role: req.auth!.role,
});

/** GET /api/appointments — the caller's bookings (tenant's, for staff/owners). */
appointmentsRouter.get(
  '/',
  validate(listAppointmentsSchema, 'query'),
  asyncHandler(async (req, res) => {
    const appointments = await service.listAppointments(ctxFrom(req), req.query as never);
    res.json({ appointments });
  }),
);

/**
 * POST /api/appointments — create a booking.
 * 201 on success. 409 if the slot is taken, 422 if outside hours or in the past.
 */
appointmentsRouter.post(
  '/',
  writeLimiter,
  validate(createAppointmentSchema),
  asyncHandler(async (req, res) => {
    const appointment = await service.createAppointmentOrThrow(ctxFrom(req), req.body);
    // Push to the customer's other open tabs and to the tenant's staff, so
    // their dashboards update without a refetch.
    emitAppointmentCreated(req.auth!.bid, appointment);
    res.status(201).json({ appointment });
  }),
);

/** GET /api/appointments/:id */
appointmentsRouter.get(
  '/:id',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  asyncHandler(async (req, res) => {
    const appointment = await service.getAppointment(ctxFrom(req), req.params.id!);
    res.json({ appointment });
  }),
);

/**
 * POST /api/appointments/:id/cancel
 *
 * A state transition modelled as a named action rather than
 * PATCH { status: 'cancelled' }: cancelling has its own rules and its own
 * payload (a reason), and an action endpoint cannot be used to set an arbitrary
 * status the server never intended to allow from the outside.
 */
appointmentsRouter.post(
  '/:id/cancel',
  writeLimiter,
  validate(z.object({ id: z.string().uuid() }), 'params'),
  validate(cancelAppointmentSchema),
  asyncHandler(async (req, res) => {
    const appointment = await service.cancelAppointment(
      ctxFrom(req),
      req.params.id!,
      req.body.reason,
    );
    // Reaches the customer even when staff cancelled it, or their open
    // dashboard keeps showing a booking that is gone, and every staff screen.
    emitAppointmentUpdated(req.auth!.bid, appointment);
    res.json({ appointment });
  }),
);

// ---------------------------------------------------------------------------
// Supporting read endpoints
// ---------------------------------------------------------------------------

export const servicesRouter = Router();
servicesRouter.use(requireAuth);

/** GET /api/services — the bookable catalogue for the caller's tenant. */
servicesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const services = await service.listServices(req.auth!.bid);
    res.json({ services });
  }),
);

/**
 * GET /api/services/:serviceId/availability?date=YYYY-MM-DD
 *
 * Powers both the form's time picker and the chatbot's suggestions, so the two
 * surfaces can never show a different set of free slots.
 */
servicesRouter.get(
  '/:serviceId/availability',
  validate(availabilitySchema.pick({ date: true }), 'query'),
  validate(z.object({ serviceId: z.string().uuid() }), 'params'),
  asyncHandler(async (req, res) => {
    const availability = await getAvailability(
      req.auth!.bid,
      req.params.serviceId!,
      (req.query as { date: string }).date,
      // Bookings are always made for the caller, so their own appointments
      // block a time as surely as another customer's.
      req.auth!.sub,
    );
    if (!availability) throw notFound('Service');
    res.json({ availability });
  }),
);
