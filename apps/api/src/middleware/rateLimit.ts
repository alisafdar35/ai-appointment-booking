import rateLimit, { type Options } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { ERROR_CODES } from '@appt/shared';
import { env } from '../config/env.js';
import { getRequestId } from './requestContext.js';

/**
 * Rate limiting is tiered by what an endpoint actually costs or protects,
 * because a single global limit is always either too loose for the login
 * endpoint or too tight for ordinary reads.
 *
 * Limits are keyed by authenticated user id when the request has been
 * authenticated by the time the limiter runs (chat and writes, which sit behind
 * requireAuth), falling back to IP otherwise (the global and credential limiters
 * run before anyone is signed in — that is the point of them). Keying on IP
 * alone punishes everyone behind one NAT or corporate proxy, and lets a single
 * attacker with a pool of addresses slip through.
 *
 * Store: in-memory, which is correct for a single instance and explicitly NOT
 * correct across replicas — see "Known limitations" in the README. The fix is a
 * Redis store, which is a config change here rather than a redesign.
 */
/** 45 -> "45 seconds", 897 -> "15 minutes": a login lockout read in seconds is hard to act on. */
function waitFor(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

function makeLimiter(opts: Partial<Options> & { windowMs: number; limit: number }): RequestHandler {
  const limiter = rateLimit({
    standardHeaders: 'draft-7', // RateLimit-* headers, so clients can self-throttle
    legacyHeaders: false,
    keyGenerator: (req) => req.auth?.sub ?? req.ip ?? 'unknown',
    handler: (req, res) => {
      const retryAfter = Number(res.getHeader('retry-after')) || undefined;
      res.status(429).json({
        error: {
          code: ERROR_CODES.RATE_LIMITED,
          message: retryAfter ? `Too many requests. Try again in ${waitFor(retryAfter)}.` : 'Too many requests. Please slow down.',
          requestId: getRequestId(req),
        },
      });
    },
    ...opts,
  });

  // Disabled wholesale in tests, where hundreds of requests fire in milliseconds
  // and would otherwise trip the limiter and produce confusing failures.
  if (env.RATE_LIMIT_DISABLED) {
    const passthrough: RequestHandler = (_req, _res, next) => next();
    return passthrough;
  }
  return limiter;
}

/** Baseline for all reads. Generous — it exists to stop runaway clients, not users. */
export const generalLimiter = makeLimiter({ windowMs: 60_000, limit: 300 });

/**
 * Login and signup. Tight, because this is where credential stuffing lands.
 * Successful requests are not counted, so a legitimate user working normally
 * never approaches the limit while a brute-force attempt hits it almost at once.
 */
export const authLimiter = makeLimiter({
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
});

/**
 * Session refresh, with a budget of its own.
 *
 * Refresh fails for ordinary reasons — an expired cookie, a tab that lost a
 * rotation race — and when it shared the login budget, a few of those were
 * enough to lock the user out of signing in again. It is also not a
 * guessing surface (a refresh token is 256 random bits), so the limit only has
 * to stop a runaway client: looser than login, and counting every request,
 * because a client stuck in a refresh loop succeeds as often as it fails.
 */
export const refreshLimiter = makeLimiter({ windowMs: 5 * 60_000, limit: 60 });

/**
 * Chat. Every message may cost a paid LLM call, so this limit protects the
 * budget as much as the service — the one place where an abusive client costs
 * real money per request.
 */
export const chatLimiter = makeLimiter({ windowMs: 60_000, limit: 20 });

/** Writes. Between the two: bookings are cheap but not free, and create rows. */
export const writeLimiter = makeLimiter({ windowMs: 60_000, limit: 40 });
