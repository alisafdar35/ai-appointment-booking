import type { AuthResponse, LoginInput, SignupInput, UserDto } from '@appt/shared';
import { withTransaction, type Queryable } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import {
  PG_ERRORS,
  badRequest,
  emailTaken,
  invalidCredentials,
  isPgError,
  pgConstraint,
  sessionSuperseded,
  unauthenticated,
} from '../../lib/errors.js';
import { generateRefreshToken, signAccessToken } from '../../lib/jwt.js';
import { equalizeTiming, hashPassword, verifyPassword } from '../../lib/password.js';
import { disconnectUser } from '../../realtime/index.js';
import * as repo from './repository.js';

/**
 * Authentication business logic.
 *
 * Route handlers in this module do HTTP (read the request, set cookies, pick a
 * status code) and nothing else; the rules live here. That boundary is what
 * makes these flows testable without an HTTP server and reusable from the
 * Socket.IO handshake, which has no `res` to set a cookie on.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  refreshExpiresAt: Date;
}

function buildTokens(user: UserDto, refreshToken: string): TokenPair {
  return {
    accessToken: signAccessToken({
      sub: user.id,
      bid: user.businessId,
      role: user.role,
      email: user.email,
    }),
    refreshToken,
    expiresInSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshExpiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
  };
}

/** "Bluewave Dental" -> "bluewave-dental", with a short suffix on collision. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    .replace(/^-|-$/g, '');
  return base || 'workspace';
}

/**
 * Create a business, adding a random suffix to its slug until one is free.
 *
 * The slug is globally unique, and "someone else already took the obvious name"
 * must not fail a signup. The repository reports a taken slug as `null`, so
 * this loop is race-free: there is no look-then-insert window for a second
 * signup to slip into.
 */
async function createBusinessWithFreeSlug(client: Queryable, name: string): Promise<{ id: string }> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const business = await repo.createBusiness(client, {
      name,
      slug,
      // Prototype assumption: new tenants default to UTC and would set their
      // real timezone in a settings screen this scope does not include.
      timezone: 'UTC',
    });
    if (business) return business;
  }
  throw badRequest('That business name is not available', { businessName: ['Try a different name'] });
}

export async function signup(
  input: SignupInput,
  meta: { userAgent?: string | undefined },
): Promise<{ auth: AuthResponse; refreshToken: string; refreshExpiresAt: Date }> {
  // Hashed before the transaction opens: bcrypt takes a few hundred
  // milliseconds, and spending them while holding a pooled connection would let
  // a burst of signups drain the pool for every other request.
  const passwordHash = await hashPassword(input.password);

  const result = await withTransaction(async (client) => {
    let businessId: string;
    let role: 'owner' | 'customer';

    if (input.businessSlug) {
      // Joining an existing tenant: the new account is a customer of it.
      const business = await repo.findBusinessBySlug(input.businessSlug, client);
      // A tenant slug is not a secret (it is the public join key), so a miss is
      // reported as what it is: a field the form can point at.
      if (!business) {
        throw badRequest('Some fields need attention', {
          businessSlug: ['No business with that name was found'],
        });
      }
      businessId = business.id;
      role = 'customer';
    } else {
      // Self-serve: create the tenant and make this account its owner.
      //
      // One workspace per owner email. Without this, a resubmitted signup (a
      // double click, a retry after a lost response) would create a second
      // business with a second account the sign-in form can never reach, since
      // login without a business code picks the oldest account. No unique
      // index can express "unique among owners" without failing on tenants
      // created before this rule, so an advisory lock on the email serialises
      // concurrent attempts and makes the check below race-free.
      await repo.lockOwnerEmail(client, input.email);
      if (await repo.ownsWorkspace(input.email, client)) {
        throw emailTaken('This email already owns a workspace. Sign in instead.');
      }
      const name = input.businessName?.trim() || `${input.fullName.split(' ')[0]}'s Workspace`;
      const business = await createBusinessWithFreeSlug(client, name);
      businessId = business.id;
      role = 'owner';
      await repo.createDefaultServices(client, businessId);
    }

    // This deliberately reveals that an email is registered with a tenant, and
    // tenant slugs are public. Closing it needs a uniform "check your inbox"
    // answer, which needs email verification this prototype does not have;
    // without it, someone who already has an account would be left stuck.
    // authLimiter caps how fast the endpoint can be probed.
    if (await repo.emailExistsInBusiness(businessId, input.email, client)) throw emailTaken();

    const user = await repo.createUser(client, {
      businessId,
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      phone: input.phone,
      role,
    });

    const refreshToken = generateRefreshToken();
    const tokens = buildTokens(user, refreshToken);
    await repo.storeRefreshToken(client, {
      userId: user.id,
      token: refreshToken,
      expiresAt: tokens.refreshExpiresAt,
      userAgent: meta.userAgent,
    });

    return { user, tokens };
  }).catch((err: unknown) => {
    // The existence check above is a courtesy for the common case. Two
    // simultaneous signups can both pass it, and UNIQUE (business_id, email) is
    // what actually decides — so the loser gets the same answer as a late one.
    if (isPgError(err, PG_ERRORS.UNIQUE_VIOLATION) && pgConstraint(err) === 'users_business_email_key') {
      throw emailTaken();
    }
    throw err;
  });

  logger.info({ userId: result.user.id, businessId: result.user.businessId }, 'User signed up');
  return {
    auth: {
      user: result.user,
      accessToken: result.tokens.accessToken,
      expiresInSeconds: result.tokens.expiresInSeconds,
    },
    refreshToken: result.tokens.refreshToken,
    refreshExpiresAt: result.tokens.refreshExpiresAt,
  };
}

export async function login(
  input: LoginInput,
  meta: { userAgent?: string | undefined },
): Promise<{ auth: AuthResponse; refreshToken: string; refreshExpiresAt: Date }> {
  const row = await repo.findUserForLogin(input.email, input.businessSlug);

  if (!row) {
    // Spend the same time a real bcrypt comparison would, then fail identically.
    // See lib/password.ts — this stops login from being a timing oracle for
    // which emails are registered. (Signup still answers that question
    // directly; see the note there.)
    await equalizeTiming();
    throw invalidCredentials();
  }

  if (!(await verifyPassword(input.password, row.password_hash))) {
    logger.warn({ email: input.email }, 'Failed login attempt');
    throw invalidCredentials();
  }

  const user = repo.toUserDto(row);
  const refreshToken = generateRefreshToken();
  const tokens = buildTokens(user, refreshToken);

  await withTransaction((client) =>
    repo.storeRefreshToken(client, {
      userId: user.id,
      token: refreshToken,
      expiresAt: tokens.refreshExpiresAt,
      userAgent: meta.userAgent,
    }),
  );

  logger.info({ userId: user.id }, 'User logged in');
  return {
    auth: { user, accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds },
    refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

/**
 * How long after a rotation the old token is "superseded" rather than "replayed".
 *
 * Every tab of one browser shares one cookie jar, so two tabs waking up after a
 * sleep refresh with the same token at the same moment. Exactly one wins the
 * rotation; the other arrives holding a token revoked milliseconds earlier —
 * which, without a grace window, is indistinguishable from theft and would sign
 * the user out everywhere for opening a second tab.
 *
 * What the window concedes is small: the loser gets a 401 and no tokens, so a
 * thief presenting a stolen token inside it gains nothing. The cost is only
 * that theft is detected on the next presentation after the window instead of
 * this one. 15 seconds comfortably covers a slow network and a cold start,
 * while staying far shorter than any realistic replay of an exfiltrated token.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 15;

/**
 * Rotate a refresh token.
 *
 * Rotation means a refresh token is single-use: presenting it returns a new
 * pair and revokes the old one. The valuable part is what happens when an
 * ALREADY-REVOKED token is presented. In normal operation that cannot happen,
 * so it implies the token was captured and is being replayed — and since we
 * cannot tell whether the attacker or the real user is the one in front of us,
 * every live token for that user is revoked and both are forced to sign in
 * again. Losing a session is a small price for closing a stolen one.
 *
 * The exception is a token rotated within the last few seconds (see
 * REFRESH_REUSE_GRACE_SECONDS and redeemRotated).
 */
export async function refresh(token: string, meta: { userAgent?: string | undefined }): Promise<RefreshResult> {
  const existing = await repo.findRefreshToken(token);
  if (!existing) throw unauthenticated('Your session has expired');

  if (existing.revoked_at) return redeemRotated(existing, meta);

  if (new Date(existing.expires_at).getTime() <= Date.now()) {
    throw unauthenticated('Your session has expired');
  }

  const user = await repo.findUserById(existing.user_id);
  if (!user) throw unauthenticated('Your session has expired');

  const nextToken = generateRefreshToken();
  const tokens = buildTokens(user, nextToken);

  // One transaction: the old token must not be revoked unless its replacement
  // was stored, or a crash between the two would log the user out silently.
  try {
    await withTransaction(async (client) => {
      const stored = await repo.storeRefreshToken(client, {
        userId: user.id,
        token: nextToken,
        expiresAt: tokens.refreshExpiresAt,
        userAgent: meta.userAgent,
      });
      // The revoke doubles as the claim on the old token. It only matches while
      // the token is still live, and a concurrent redemption blocks on the row
      // until the first commits and then matches nothing — so exactly one
      // request gets to issue a successor. The read above is not enough: two
      // requests can both see the token live.
      const claimed = await repo.revokeRefreshToken(client, existing.id, stored.id);
      if (!claimed) throw new TokenAlreadyRotated();
    });
  } catch (err) {
    if (err instanceof TokenAlreadyRotated) return redeemRotated(existing, meta);
    throw err;
  }

  return {
    auth: { user, accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds },
    refreshToken: nextToken,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

/** Thrown inside the rotation transaction to roll back the successor token. */
class TokenAlreadyRotated extends Error {}

type RefreshResult = { auth: AuthResponse; refreshToken: string; refreshExpiresAt: Date };

/**
 * A token that was already rotated is presented again. Inside the grace window
 * there are two innocent explanations, told apart by the successor:
 *
 *   - Its successor has been used (rotated or signed out). Another tab won
 *     the race and the browser already holds the newer cookie: refuse with
 *     SESSION_SUPERSEDED and revoke nothing.
 *   - Its successor was never used. The response that carried it was lost
 *     (a timeout during a cold start), so no newer cookie will ever arrive and
 *     SESSION_SUPERSEDED would be final. Treat the rotation as abandoned:
 *     revoke the unused successor and issue a fresh pair, as Auth0's reuse
 *     interval does.
 *
 * A successor revoked that way is marked abandoned; if it turns up after all,
 * it is superseded too. Outside the window it is a replay (rejectReplay), and
 * so is a token ended by logout (no successor). The presented token and
 * its successor are row-locked for the decision, so two retries of one token
 * cannot both take over the same successor.
 */
async function redeemRotated(token: repo.RefreshTokenRow, meta: { userAgent?: string | undefined }): Promise<RefreshResult> {
  // Read before the transaction, so it does not hold a second pooled connection.
  const user = await repo.findUserById(token.user_id);
  const outcome = await withTransaction(async (client) => {
    const rotation = await repo.lockRotation(client, token.id, REFRESH_REUSE_GRACE_SECONDS);
    if (!rotation.recent || !rotation.successorId) return 'replay' as const;
    // An abandoned successor presented after all: its response did arrive, and
    // a retry has already taken over. Recovering again would revoke that one.
    if (rotation.abandoned || !rotation.successorUnused) return 'superseded' as const;
    if (!user || new Date(token.expires_at).getTime() <= Date.now()) return 'expired' as const;

    const nextToken = generateRefreshToken();
    const tokens = buildTokens(user, nextToken);
    const stored = await repo.storeRefreshToken(client, {
      userId: user.id,
      token: nextToken,
      expiresAt: tokens.refreshExpiresAt,
      userAgent: meta.userAgent,
    });
    await repo.replaceAbandonedSuccessor(client, token.id, rotation.successorId, stored.id);
    return { tokens, user };
  });

  if (outcome === 'replay') return rejectReplay(token);
  if (outcome === 'expired') throw unauthenticated('Your session has expired');
  if (outcome === 'superseded') {
    logger.info({ userId: token.user_id, tokenId: token.id }, 'Refresh token superseded by a concurrent rotation');
    throw sessionSuperseded();
  }
  logger.warn({ userId: token.user_id, tokenId: token.id }, 'Abandoned refresh rotation recovered with a fresh pair');
  const { tokens } = outcome;
  return {
    auth: { user: outcome.user, accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds },
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

async function rejectReplay(token: repo.RefreshTokenRow): Promise<never> {
  await withTransaction((client) => repo.revokeAllForUser(client, token.user_id));
  // Live sockets were authenticated before the theft was noticed; close them too.
  disconnectUser(token.user_id);
  logger.error(
    { userId: token.user_id, tokenId: token.id },
    'Revoked refresh token replayed — all sessions revoked as a precaution',
  );
  throw unauthenticated('Your session was ended for security reasons. Please sign in again.');
}

export async function logout(token: string | undefined, everywhere = false): Promise<void> {
  if (!token) return; // Already signed out; nothing to do and no reason to error.
  const existing = await repo.findRefreshToken(token);
  if (!existing) return;
  await withTransaction(async (client) => {
    if (everywhere) await repo.revokeAllForUser(client, existing.user_id);
    else await repo.revokeRefreshToken(client, existing.id);
  });
  // Signing out everywhere ends every device's realtime feed as well. A single
  // logout leaves the user's other devices connected: they are still signed in.
  if (everywhere) disconnectUser(existing.user_id);
  logger.info({ userId: existing.user_id, everywhere }, 'User logged out');
}

export const getCurrentUser = repo.findUserById;
