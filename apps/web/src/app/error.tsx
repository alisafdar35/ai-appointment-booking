'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button, buttonStyles } from '@/components/ui/Button';
import { ROUTES } from '@/lib/routes';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // No error-reporting service is wired up, so the browser console is the
    // only place a developer can see what actually broke.
    console.error(error);
  }, [error]);

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-lg items-center px-4">
      <Alert
        tone="error"
        title="Something went wrong"
        className="w-full"
        action={
          <div className="flex flex-wrap gap-2">
            <Button onClick={reset}>Try again</Button>
            <Link href={ROUTES.home} className={buttonStyles({ variant: 'secondary' })}>
              Go to home
            </Link>
          </div>
        }
      >
        <p>This page hit an unexpected problem. Your data is safe. Try again, or head back to the start.</p>
        {error.digest ? <p className="mt-2 text-xs text-muted-foreground">Reference: {error.digest}</p> : null}
      </Alert>
    </main>
  );
}
