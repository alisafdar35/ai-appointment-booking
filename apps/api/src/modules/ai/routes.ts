import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getAiUsageSummary } from './logs.js';

export const aiRouter = Router();
aiRouter.use(requireAuth);

/**
 * GET /api/ai/summary — the caller's tenant's AI usage over the last 24 hours.
 *
 * Owner-only and tenant-scoped: call volumes and failure rates are business
 * information, so they do not belong on the unauthenticated health probe.
 */
aiRouter.get(
  '/summary',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const summary = await getAiUsageSummary(req.auth!.bid);
    res.json({ summary });
  }),
);
