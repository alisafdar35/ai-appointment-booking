import { CircleCheck, MessageSquare, Plus } from 'lucide-react';
import type { ChatSessionDto } from '@appt/shared';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/utils';
import type { SessionKey } from '../lib/reducer';
import { formatSessionTime } from '../lib/session-time';

interface SessionListProps {
  sessions: ChatSessionDto[] | undefined;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  activeKey: SessionKey | undefined;
  timeZone: string;
  onSelect: (key: SessionKey) => void;
  onNew: () => void;
}

/** The conversation list: newest activity first, the open one marked, and a way to start over. */
export function SessionList({ sessions, isPending, isError, onRetry, activeKey, timeZone, onSelect, onNew }: SessionListProps) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Button
        variant="secondary"
        fullWidth
        onClick={onNew}
        leftIcon={<Plus className="size-4" aria-hidden="true" />}
      >
        New conversation
      </Button>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isPending ? (
          <div role="status" className="space-y-2">
            <span className="sr-only">Loading conversations</span>
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <div className="space-y-2 px-1 text-sm text-muted-foreground">
            <p>We couldn&rsquo;t load your conversations.</p>
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : !sessions || sessions.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">Your conversations will appear here.</p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((session) => {
              const active = session.id === activeKey;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onSelect(session.id)}
                    // The ring is drawn inside: the list scrolls, and an outside ring is clipped at its edges.
                    className={cn(
                      'flex min-h-14 w-full flex-col justify-center gap-0.5 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-offset-[-2px]',
                      active ? 'bg-accent-subtle' : 'hover:bg-muted',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {session.status === 'completed' ? (
                        <CircleCheck className="size-3.5 shrink-0 text-success-text" role="img" aria-label="Booked" />
                      ) : (
                        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                      <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', active ? 'text-accent-text' : 'text-foreground')}>
                        {session.title}
                      </span>
                    </span>
                    <span className="pl-[1.375rem] text-xs tabular-nums text-muted-foreground">
                      {formatSessionTime(session.lastMessageAt ?? session.createdAt, timeZone)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
