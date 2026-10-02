'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { loginHref, ROUTES } from '@/lib/routes';
import { useAuth } from '@/providers/AuthProvider';
import { AppShellSkeleton } from './AppShellSkeleton';

/**
 * Client-side route protection for everything under (app)/.
 *
 * It cannot be Next.js middleware: the refresh cookie is scoped to
 * /api/auth, so middleware (which runs on page requests) never sees it and
 * cannot tell a signed-in user from a stranger. The cost of the client-side
 * approach is that the protected page's JS is delivered before the check; the
 * data is not, because every API call is authorised server-side regardless.
 * Content is only rendered once the session is confirmed, and a skeleton stands
 * in meanwhile so there is no flash of the wrong page.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const { status, sessionEnd } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (status !== 'unauthenticated') return;
    // Remember where they were headed — unless they chose to leave.
    const destination = sessionEnd === 'signed-out' ? ROUTES.login : loginHref(`${pathname}${window.location.search}`);
    router.replace(destination);
  }, [status, sessionEnd, pathname, router]);

  if (status !== 'authenticated') return <AppShellSkeleton />;
  return <>{children}</>;
}
