import { Router } from 'express';
import type { CookieOptions, Response } from 'express';
import { ERROR_CODES, loginSchema, signupSchema } from '@appt/shared';
import { env } from '../../config/env.js';
import { AppError, notFound, unauthenticated } from '../../lib/errors.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { authLimiter, refreshLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';

/**
 * Cookie policy.
 *
 * httpOnly  — JavaScript cannot read these, so an XSS bug cannot exfiltrate a
 *             session. This is the main reason tokens are not in localStorage.
 * secure    — HTTPS only in production.
 * sameSite  — 'lax' when the web app proxies /api/* through its own origin
 *             (the default deployment, so cookies are first-party), 'none'
 *             when the API is called cross-site, which browsers only honour
 *             together with Secure.
 * path      — the refresh cookie is scoped to the refresh/logout endpoints, so
 *             it is not attached to ordinary API requests and cannot leak from
 *             one that goes wrong.
 */
function cookieOptions(maxAgeMs: number, path = '/'): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.CROSS_SITE_COOKIES ? 'none' : 'lax',
    path,
    maxAge: maxAgeMs,
  };
}

const REFRESH_PATH = '/api/auth';

function setAuthCookies(res: Response, accessToken: string, refreshToken: string, refreshExpiresAt: Date): void {
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(env.ACCESS_TOKEN_TTL_SECONDS * 1000));
  res.cookie(
    REFRESH_COOKIE,
    refreshToken,
    cookieOptions(Math.max(0, refreshExpiresAt.getTime() - Date.now()), REFRESH_PATH),
  );
}

function clearAuthCookies(res: Response): void {
  // Options must match those used to set the cookie, or the browser keeps it.
  res.clearCookie(ACCESS_COOKIE, { ...cookieOptions(0), maxAge: undefined });
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(0, REFRESH_PATH), maxAge: undefined });
}

export const authRouter = Router();

/**
 * POST /api/auth/signup
 * 201 — account created. Creates a new tenant unless businessSlug joins one.
 */
authRouter.post(
  '/signup',
  authLimiter,
  validate(signupSchema),
  asyncHandler(async (req, res) => {
    const { auth, refreshToken, refreshExpiresAt } = await service.signup(req.body, {
      userAgent: req.header('user-agent'),
    });
    setAuthCookies(res, auth.accessToken, refreshToken, refreshExpiresAt);
    res.status(201).json(auth);
  }),
);

/** POST /api/auth/login — 200 with the user and a short-lived access token. */
authRouter.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { auth, refreshToken, refreshExpiresAt } = await service.login(req.body, {
      userAgent: req.header('user-agent'),
    });
    setAuthCookies(res, auth.accessToken, refreshToken, refreshExpiresAt);
    res.json(auth);
  }),
);

/**
 * POST /api/auth/refresh
 *
 * Authenticated by the refresh cookie alone, so the web app can recover a
 * session after a reload without ever exposing a token to JavaScript. The
 * response body carries the new access token because the Socket.IO handshake
 * needs a value JS can read (the cookie is httpOnly by design).
 */
authRouter.post(
  '/refresh',
  refreshLimiter,
  asyncHandler(async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token) throw unauthenticated('No active session');
    try {
      const { auth, refreshToken, refreshExpiresAt } = await service.refresh(token, {
        userAgent: req.header('user-agent'),
      });
      setAuthCookies(res, auth.accessToken, refreshToken, refreshExpiresAt);
      res.json(auth);
    } catch (err) {
      // A dead refresh token must not stay in the browser: otherwise every page
      // load retries it and the client cannot tell "expired" from "broken".
      // A superseded one is the exception: the tab that won the race has
      // already set its successor in the same cookie jar, and clearing here
      // would sign that tab out too.
      const superseded = err instanceof AppError && err.code === ERROR_CODES.SESSION_SUPERSEDED;
      if (!superseded) clearAuthCookies(res);
      throw err;
    }
  }),
);

/** POST /api/auth/logout — 204. Idempotent: logging out twice is not an error. */
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    await service.logout(token, req.query.everywhere === 'true');
    clearAuthCookies(res);
    res.status(204).end();
  }),
);

/** GET /api/auth/me — the current user, used to hydrate the client on load. */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await service.getCurrentUser(req.auth!.sub);
    // The token verified but the user is gone: a deleted account holding a
    // still-valid access token. Treat as 404 rather than a 500.
    if (!user) throw notFound('Account');
    res.json({ user });
  }),
);
