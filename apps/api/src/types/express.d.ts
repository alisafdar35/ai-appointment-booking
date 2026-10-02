import type { AccessTokenClaims } from '../lib/jwt.js';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id, echoed to the client and attached to every log line. */
      id: string;
      /** Populated by requireAuth. Absent means unauthenticated, by construction. */
      auth?: AccessTokenClaims;
    }
  }
}
export {};
