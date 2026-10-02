import { CircleAlert, MessageSquarePlus, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useCountdown } from '../hooks/useCountdown';
import type { SendFailure } from '../lib/reducer';

interface FailureNoticeProps {
  failure: SendFailure;
  onRetry: () => void;
}

/**
 * Sits under a message that could not be sent. The text is never lost: the
 * bubble stays in the transcript and Retry sends exactly what was typed. When
 * the server rate-limited us, Retry waits out the interval it asked for. When
 * the conversation had already booked, the same text goes to a new one.
 */
export function FailureNotice({ failure, onRetry }: FailureNoticeProps) {
  const secondsLeft = useCountdown(failure.retryAfterSeconds, failure.failedAt);
  const Icon = failure.sessionClosed ? MessageSquarePlus : RotateCw;
  const label = failure.sessionClosed
    ? 'Send in a new conversation'
    : secondsLeft > 0
      ? `Retry in ${secondsLeft}s`
      : 'Retry';

  return (
    <div role="alert" className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-danger-text">
      <span className="inline-flex items-center gap-1.5">
        <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        {failure.message}
      </span>
      <Button
        size="sm"
        variant="secondary"
        disabled={secondsLeft > 0}
        onClick={onRetry}
        leftIcon={<Icon className="size-3.5" aria-hidden="true" />}
      >
        {label}
      </Button>
    </div>
  );
}
