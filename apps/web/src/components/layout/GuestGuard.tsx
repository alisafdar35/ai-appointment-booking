'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { safeNextPath } from '@/lib/routes';
import { useAuth } from '@/providers/AuthProvider';
import { CenteredLoader } from './AppShellSkeleton';

/**
 * Wrap pages that only make sense signed out (/login, /signup). A signed-in
 * visitor is sent on to `?next=` (validated: see safeNextPath) or the default
 * landing page. `next` is read in the effect rather than via useSearchParams so
 * the page stays statically renderable without a Suspense boundary.
 */
export function GuestGuard({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status !== 'authenticated') return;
    router.replace(safeNextPath(new URLSearchParams(window.location.search).get('next')));
  }, [status, router]);

  if (status !== 'unauthenticated') return <CenteredLoader />;
  return <>{children}</>;
}
