/**
 * A one-bit "this browser has signed in before" marker.
 *
 * The refresh cookie is httpOnly and path-scoped, so JavaScript cannot tell
 * whether a session might exist. Without a hint, every anonymous page view
 * would POST /api/auth/refresh just to receive a 401: a wasted round trip,
 * a red line in the console, and a spend from the per-IP refresh rate-limit
 * budget that users behind one address share.
 *
 * The hint carries no credential: stealing it gains nothing, and a stale one
 * costs a single 401 that then clears it.
 */
const KEY = 'slotly.session';

export function hasSessionHint(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    // Storage blocked (private mode, strict settings): fall back to asking the server.
    return true;
  }
}

export function setSessionHint(present: boolean): void {
  try {
    if (present) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    // Non-fatal: the hint only saves a request.
  }
}
