/**
 * In-memory access-token store.
 *
 * Why memory and not localStorage: anything in localStorage is readable by any
 * script on the page, so one XSS bug would hand over a usable credential. The
 * real session lives in httpOnly cookies the browser attaches by itself; this
 * short-lived copy exists only because the Socket.IO handshake needs a value
 * JavaScript can read. It vanishes on reload and is re-acquired from
 * POST /api/auth/refresh, which the httpOnly refresh cookie authorises.
 */
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
