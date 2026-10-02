export const ROUTES = {
  home: '/',
  login: '/login',
  signup: '/signup',
  assistant: '/assistant',
  appointments: '/appointments',
} as const;

/** Where a signed-in user lands when no (valid) `next` target is given. */
export const DEFAULT_AUTHENTICATED_ROUTE = ROUTES.assistant;

const AUTH_PAGES: readonly string[] = [ROUTES.login, ROUTES.signup];

/**
 * Accept a post-login redirect only if it is a same-origin path.
 *
 * `next` comes from the query string, so it is attacker-controlled: without
 * this check, /login?next=https://evil.example turns the login page into an
 * open redirect that sends a freshly authenticated user to a phishing site.
 * Parsing against a throwaway origin catches the tricks a prefix check misses
 * (`//evil.example`, `/\evil.example`, `javascript:` and encoded variants).
 */
export function safeNextPath(raw: string | null | undefined, fallback: string = DEFAULT_AUTHENTICATED_ROUTE): string {
  if (!raw || !raw.startsWith('/')) return fallback;
  try {
    const base = 'http://slotly.invalid';
    const url = new URL(raw, base);
    if (url.origin !== base) return fallback;
    // Bouncing a signed-in user back to the login form would just loop.
    if (AUTH_PAGES.includes(url.pathname)) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

/** Set on /login when the user was sent there because their session ended, so the page can say why. */
export const SESSION_EXPIRED_PARAM = 'expired';

/** /login, remembering where the user was headed and, optionally, that their session had ended. */
export function loginHref(next?: string, { expired = false }: { expired?: boolean } = {}): string {
  const target = next ? safeNextPath(next, '') : '';
  const params = new URLSearchParams();
  if (target) params.set('next', target);
  if (expired) params.set(SESSION_EXPIRED_PARAM, '1');
  const query = params.toString();
  return query ? `${ROUTES.login}?${query}` : ROUTES.login;
}
