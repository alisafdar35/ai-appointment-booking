import type { RequestHandler } from 'express';
import { forbidden, unauthenticated } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';

export const ACCESS_COOKIE = 'appt_access';
export const REFRESH_COOKIE = 'appt_refresh';

/**
 * Accept the access token from either an httpOnly cookie or an Authorization
 * header.
 *
 * The cookie is what the browser uses: because the web app proxies /api/*
 * through its own origin, the cookie is first-party, which keeps it out of
 * reach of JavaScript (XSS) without relying on third-party cookie support.
 * The header exists so the API is directly usable with curl, Postman or any
 * non-browser client — including a reviewer exercising it by hand.
 */
function extractToken(req: Parameters<RequestHandler>[0]): string | null {
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const cookie = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
  return cookie ?? null;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = extractToken(req);
  if (!token) {
    next(unauthenticated());
    return;
  }
  // verifyAccessToken throws a typed AppError; let it propagate to the handler.
  req.auth = verifyAccessToken(token);
  next();
};

/** Restrict a route to some roles. Mounted after requireAuth, which sets req.auth. */
export const requireRole =
  (...roles: string[]): RequestHandler =>
  (req, _res, next) => {
    next(req.auth && roles.includes(req.auth.role) ? undefined : forbidden());
  };
