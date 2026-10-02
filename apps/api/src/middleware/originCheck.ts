import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { forbidden } from '../lib/errors.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence in depth: refuse a state-changing request that a browser says
 * came from a page we do not trust.
 *
 * SameSite=Lax cookies already keep the session off cross-site POSTs, and the
 * JSON-only body parser means a plain HTML form cannot produce a body the
 * routes accept. Both are indirect, though, and the first is switched off
 * deliberately when CROSS_SITE_COOKIES=true. Browsers attach Origin to every
 * cross-origin request and every non-GET request, and a page cannot forge it,
 * so checking it against the CORS allow-list closes the gap directly.
 *
 * A request with no Origin passes. That is curl, a server-to-server call or a
 * test client — none of which carries a victim's ambient cookies — and
 * refusing them would break the API for every non-browser consumer.
 *
 * The Next.js proxy forwards the browser's own Origin, so requests through it
 * pass exactly when the web app's origin is listed in CORS_ORIGINS, as it is
 * by default. Socket.IO is not covered here: its handshake is checked by its
 * own CORS configuration and authenticated by token, not by cookie.
 */
export const rejectForeignOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.header('origin');
  if (!STATE_CHANGING.has(req.method) || origin === undefined || env.corsOrigins.includes(origin)) {
    next();
    return;
  }
  next(forbidden('This request came from a site that is not allowed to make it'));
};
