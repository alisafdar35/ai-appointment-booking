import { Router } from 'express';
import { z } from 'zod';
import { sendMessageSchema, submitDraftSchema } from '@appt/shared';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { chatLimiter, writeLimiter } from '../../middleware/rateLimit.js';
import { getRequestId } from '../../middleware/requestContext.js';
import { validate } from '../../middleware/validate.js';
import { emitAppointmentCreated, emitAssistantTurn, typingIndicator } from '../../realtime/index.js';
import * as service from './service.js';

export const chatRouter = Router();
chatRouter.use(requireAuth);

const ctxFrom = (req: { auth?: { sub: string; bid: string }; id?: unknown }) => ({
  businessId: req.auth!.bid,
  userId: req.auth!.sub,
  requestId: getRequestId(req),
});

/** GET /api/chat/sessions — the conversation sidebar. */
chatRouter.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const sessions = await service.listSessions(ctxFrom(req));
    res.json({ sessions });
  }),
);

/** POST /api/chat/sessions — start an empty conversation. */
chatRouter.post(
  '/sessions',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const session = await service.createSession(ctxFrom(req));
    res.status(201).json({ session });
  }),
);

/** GET /api/chat/sessions/:id — the session, its transcript, and the bookings it made. */
chatRouter.get(
  '/sessions/:id',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  asyncHandler(async (req, res) => {
    const transcript = await service.getTranscript(ctxFrom(req), req.params.id!);
    res.json(transcript);
  }),
);

/**
 * POST /api/chat/messages — send a message and get the assistant's turn.
 *
 * Rate limited harder than ordinary writes because each call may cost a paid
 * LLM request. Returns the whole turn (reply, action, server-side draft,
 * missing fields, and the appointment when one was created) so the client
 * renders from one authoritative payload rather than stitching state together
 * from several calls.
 *
 * This is the REST path, and it is complete on its own — the Socket.IO channel
 * is an enhancement for live delivery, not a requirement. If the websocket
 * never connects, the app still works.
 *
 * While the assistant works, the user's other tabs are told it is typing, and
 * the indicator is always cleared — a failed turn cannot leave it stuck.
 */
chatRouter.post(
  '/messages',
  chatLimiter,
  validate(sendMessageSchema),
  asyncHandler(async (req, res) => {
    const userId = req.auth!.sub;
    const typing = typingIndicator(userId);
    try {
      const turn = await service.handleUserMessage(ctxFrom(req), req.body, { onGenerating: typing.start });
      // Cleared before the turn is mirrored, so no tab shows the reply beneath
      // a typing indicator; the `finally` covers a turn that fails instead.
      typing.stop();

      // Mirror to the user's other connected clients so a second tab stays in sync.
      emitAssistantTurn(userId, turn);
      if (turn.appointment) emitAppointmentCreated(req.auth!.bid, turn.appointment);

      res.status(201).json(turn);
    } finally {
      typing.stop();
    }
  }),
);

/**
 * POST /api/chat/draft — complete a booking from the structured fallback form.
 *
 * The escape hatch for when the conversation is not converging: the same
 * booking rules, reached through a form instead of prose.
 */
chatRouter.post(
  '/draft',
  writeLimiter,
  validate(submitDraftSchema),
  asyncHandler(async (req, res) => {
    const turn = await service.submitDraft(ctxFrom(req), req.body.sessionId, req.body.slots);
    emitAssistantTurn(req.auth!.sub, turn);
    if (turn.appointment) emitAppointmentCreated(req.auth!.bid, turn.appointment);
    res.status(201).json(turn);
  }),
);
