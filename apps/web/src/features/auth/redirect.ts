import { safeNextPath, type ROUTES } from '@/lib/routes';

/** The query parameter that carries "where the user was headed" across the auth pages. */
export const NEXT_PARAM = 'next';

export type AuthRoute = typeof ROUTES.login | typeof ROUTES.signup;

/**
 * Link between /login and /signup without losing the post-auth destination.
 *
 * The incoming value is attacker-controlled (it is read from the URL), so it is
 * validated again here rather than trusted because the page it came from
 * "already checked": a poisoned `next` must not be laundered into a link we
 * render ourselves. An unsafe or default destination is dropped, leaving a
 * clean URL.
 */
export function authPageHref(route: AuthRoute, rawNext: string | null | undefined): string {
  const next = safeNextPath(rawNext, '');
  return next ? `${route}?${NEXT_PARAM}=${encodeURIComponent(next)}` : route;
}
