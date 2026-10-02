'use client';

import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/providers/AuthProvider';

/**
 * What the loading screen says while the session is being restored. Nothing
 * at first (it usually takes well under a second); after a few seconds, that
 * the server is waking up; and if every attempt failed, a way to try again.
 * The session is never treated as signed out here: only the server's own
 * "not signed in" does that.
 */
export function SessionRestoreNotice() {
  const { status, restore, retryRestore } = useAuth();
  if (status !== 'loading' || restore === 'checking') return null;

  if (restore === 'unreachable') {
    return (
      <Alert
        tone="warning"
        title="We couldn't reach Slotly"
        action={
          <Button size="sm" variant="secondary" onClick={retryRestore}>
            Try again
          </Button>
        }
      >
        The server is taking longer than usual to respond. You are still signed in; try again in a moment.
      </Alert>
    );
  }

  return (
    <p role="status" className="text-sm text-muted-foreground">
      Waking up the server. This can take up to a minute on the free tier&hellip;
    </p>
  );
}
