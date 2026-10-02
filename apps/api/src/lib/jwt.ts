import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthenticated } from './errors.js';

export interface AccessTokenClaims {
  sub: string;        // user id
  bid: string;        // business id — tenant scope travels in the token
  role: string;
  email: string;
}

const ISSUER = 'appt-api';

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: ISSUER,
    algorithm: 'HS256',
  });
}

/** What a verified token carries: the signed claims plus the registered ones jsonwebtoken checked. */
export type VerifiedAccessToken = AccessTokenClaims & { exp: number; iat: number };

export function verifyAccessToken(token: string): VerifiedAccessToken {
  try {
    // `algorithms` is pinned explicitly. Without it a verifier can be tricked
    // into accepting a token whose header asks for a weaker algorithm.
    const payload = jwt.verify(token, env.JWT_SECRET, {
      issuer: ISSUER,
      algorithms: ['HS256'],
    });
    if (typeof payload === 'string' || !payload.sub) throw new Error('Malformed token payload');
    return payload as unknown as VerifiedAccessToken;
  } catch (err) {
    throw unauthenticated(
      err instanceof jwt.TokenExpiredError ? 'Your session has expired' : 'Invalid session',
    );
  }
}

/**
 * Refresh tokens are opaque random strings, not JWTs.
 *
 * A JWT refresh token cannot be revoked before it expires without a denylist,
 * which means a server round-trip anyway. Since we are hitting the database
 * regardless, an opaque token with a server-side record is simpler and strictly
 * more revocable. Only its SHA-256 is stored, so a leaked table yields nothing
 * usable. SHA-256 rather than bcrypt here because the token is 256 bits of
 * entropy — there is no dictionary to slow down.
 */
export const generateRefreshToken = (): string => randomBytes(32).toString('base64url');

export const hashRefreshToken = (token: string): Buffer =>
  createHash('sha256').update(token).digest();
