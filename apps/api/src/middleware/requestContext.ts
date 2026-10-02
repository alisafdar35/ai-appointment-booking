import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from '../lib/logger.js';

/**
 * Assigns every request a correlation id before anything else runs.
 *
 * An inbound X-Request-Id is honoured so a trace survives a proxy hop (the web
 * app proxies /api/* through Next.js), and the id is echoed back in the
 * response so a user reporting "it failed" can hand over something that finds
 * the exact log lines — and the AI call they triggered, via ai_interaction_logs.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.header('x-request-id');
  const id = inbound && /^[A-Za-z0-9._-]{8,128}$/.test(inbound) ? inbound : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
};

/**
 * Read the correlation id as a string.
 *
 * pino-http augments Node's IncomingMessage with `id: ReqId` (number | string |
 * object), which widens `req.id` everywhere. Our middleware always assigns a
 * string, so this narrows it once instead of casting at every call site.
 */
export const getRequestId = (req: { id?: unknown }): string =>
  typeof req.id === 'string' ? req.id : String(req.id ?? '');

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as { id?: string }).id ?? randomUUID(),
  // Health checks would otherwise dominate the log volume on a platform that
  // polls them every few seconds.
  autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/api/health' },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  // Trim the default serialisers: full req/res objects make logs unreadable and
  // are the usual way a header or cookie ends up persisted somewhere.
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
