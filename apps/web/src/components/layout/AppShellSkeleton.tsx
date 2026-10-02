import type { ReactNode } from 'react';
import { Logo } from '@/components/ui/Logo';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';

/**
 * Shown while the session is being restored (and while a redirect is in
 * flight). It has the same silhouette as the real shell so the page does not
 * jump when content arrives, and never renders anything user-specific.
 */
export function AppShellSkeleton({ notice }: { notice?: ReactNode } = {}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Logo />
          <Skeleton className="ml-4 hidden h-9 w-64 md:block" />
          <Skeleton className="ml-auto size-9 rounded-full" />
        </div>
      </header>
      <main id="main" aria-busy="true" className="mx-auto w-full max-w-6xl flex-1 space-y-4 px-4 py-8 sm:px-6">
        <p role="status" className="sr-only">
          Loading your workspace
        </p>
        {notice}
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
        <Skeleton className="mt-6 h-64 w-full rounded-xl" />
      </main>
    </div>
  );
}

/** For pages with no app frame (sign-in, sign-up) while the session settles. */
export function CenteredLoader({ notice }: { notice?: ReactNode } = {}) {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <Spinner className="size-6 text-muted-foreground" label="Loading" />
        {notice}
      </div>
    </main>
  );
}
