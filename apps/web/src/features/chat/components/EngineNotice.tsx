import { Alert } from '@/components/ui/Alert';

/**
 * Shown once per conversation when replies come from the rule-based engine.
 * It states the fact and the reassurance, nothing about why: the client cannot
 * know the server's configuration, and guessing at it would be dishonest.
 */
export function EngineNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Alert tone="info" role="status" onDismiss={onDismiss} className="py-3">
      Running in guided mode &mdash; I can still book your appointment.
    </Alert>
  );
}
