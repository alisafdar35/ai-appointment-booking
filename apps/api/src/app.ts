import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { errorHandler, notFoundHandler, asyncHandler } from './middleware/errorHandler.js';
import { rejectForeignOrigin } from './middleware/originCheck.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { httpLogger, requestId } from './middleware/requestContext.js';
import { aiRouter } from './modules/ai/routes.js';
import { appointmentsRouter, servicesRouter } from './modules/appointments/routes.js';
import { authRouter } from './modules/auth/routes.js';
import { chatRouter } from './modules/chat/routes.js';

/**
 * Builds the Express app without listening. Keeping construction separate from
 * `listen()` is what lets a test serve it on an ephemeral port and drive it over
 * real HTTP, and lets index.ts attach Socket.IO to the same HTTP server.
 *
 * Middleware order matters and is deliberate:
 *   requestId -> logger        every later log line carries the correlation id
 *   helmet, cors, compression  transport-level concerns, before any parsing
 *   origin check               a forged cross-site write is refused before its
 *                              body is even read
 *   body parsers (size-capped) before anything reads req.body
 *   rate limiter               before routing, so floods are cheap to reject
 *   routers
 *   notFound -> errorHandler   always last; the only place errors become responses
 */
export function createApp(): Express {
  const app = express();

  // Behind proxies the client IP arrives in X-Forwarded-For, each proxy
  // appending the address it received from. In the documented deployment the
  // browser's request passes through the Vercel /api rewrite and then Render's
  // edge, so the client is two hops back; trusting only one would make every
  // user look like Vercel's egress address and share one per-IP rate-limit
  // budget. The count is configuration (TRUST_PROXY_HOPS) because it is a fact
  // about the deployment, not the code — and trusting more hops than exist
  // would let a client choose its own address.
  if (env.TRUST_PROXY_HOPS > 0) app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(httpLogger);
  app.use(helmet());
  app.use(
    cors((req, callback) => {
      const origin = req.header('origin');
      callback(null, {
        origin: env.corsOrigins,
        // The cors package sends Allow-Credentials on every response once it is
        // on, even to an origin it has just refused. Granting it per request
        // keeps the header meaning what it says: only a listed origin has it.
        credentials: origin !== undefined && env.corsOrigins.includes(origin),
        exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      });
    }),
  );
  app.use(compression());
  app.use(rejectForeignOrigin);
  // 100kb is generous for chat and booking payloads; a larger body is abuse.
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  /**
   * Liveness + readiness in one. Reports DB reachability (a platform should
   * stop routing to an instance that cannot reach Postgres) and whether the
   * LLM path is configured, so a reviewer can see at a glance which engine is
   * serving. Kept to one trivial query because it is probed constantly and
   * needs no authentication; AI usage is tenant data and lives behind an
   * owner login at /api/ai/summary. Registered before the rate limiter:
   * platform probes must never be throttled.
   */
  app.get(
    ['/health', '/api/health'],
    asyncHandler(async (_req, res) => {
      let db: 'up' | 'down' = 'up';
      try {
        await pool.query('SELECT 1');
      } catch {
        db = 'down';
      }
      res.status(db === 'up' ? 200 : 503).json({
        status: db === 'up' ? 'ok' : 'degraded',
        db,
        aiProvider: env.aiEnabled ? 'mistral' : 'fallback-only',
        uptimeSeconds: Math.round(process.uptime()),
      });
    }),
  );

  app.use('/api', generalLimiter);
  app.use('/api/auth', authRouter);
  app.use('/api/appointments', appointmentsRouter);
  app.use('/api/services', servicesRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/ai', aiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
