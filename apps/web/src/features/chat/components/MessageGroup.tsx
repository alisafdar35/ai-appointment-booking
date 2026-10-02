import { CircleAlert } from 'lucide-react';
import type { ServiceDto } from '@appt/shared';
import { formatDateTime, formatTime } from '@/lib/datetime';
import { cn } from '@/lib/utils';
import { AssistantAvatar } from './AssistantAvatar';
import { EngineBadge, isLanguageEngine } from './EngineBadge';
import { FailureNotice } from './FailureNotice';
import { TurnCard, type MessageView, type TurnActions } from './TurnCard';

interface MessageGroupProps {
  role: 'user' | 'assistant';
  views: MessageView[];
  services: readonly ServiceDto[];
  timeZone: string;
  actions: TurnActions;
  onRetry: (clientKey: string) => void;
}

/**
 * Consecutive messages from one speaker: one avatar, tightly stacked bubbles,
 * one timestamp. The timestamp is the quiet metadata line rather than a label
 * on every bubble, which keeps a fast exchange from looking like a log file.
 */
export function MessageGroup({ role, views, services, timeZone, actions, onRetry }: MessageGroupProps) {
  const isUser = role === 'user';
  const last = views[views.length - 1]!.item;

  return (
    <div className={cn('flex gap-2', isUser && 'flex-row-reverse')}>
      {isUser ? null : <AssistantAvatar />}

      <div
        className={cn(
          'flex min-w-0 flex-col gap-1',
          isUser ? 'max-w-[85%] items-end sm:max-w-[70%]' : 'flex-1 items-start',
        )}
      >
        {views.map((view, index) => {
          const { item } = view;
          const isLastInGroup = index === views.length - 1;
          // Read from the message itself, so an earlier failed reply keeps its styling after a reload.
          const errored = item.action === 'error';

          return (
            <div key={item.key} className={cn('flex w-full flex-col gap-2', isUser ? 'items-end' : 'items-start')}>
              <div
                title={formatDateTime(item.createdAt, timeZone)}
                className={cn(
                  'w-fit max-w-full whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-6 sm:text-[15px]',
                  isUser
                    ? cn(
                        'bg-accent text-accent-foreground',
                        isLastInGroup && 'rounded-br-md',
                        item.status === 'pending' && 'opacity-70',
                        item.status === 'failed' && 'bg-danger-subtle text-danger-text ring-1 ring-inset ring-danger-border',
                      )
                    : cn(
                        'bg-muted text-foreground sm:max-w-[34rem]',
                        isLastInGroup && 'rounded-bl-md',
                        errored && 'bg-danger-subtle text-danger-text ring-1 ring-inset ring-danger-border',
                      ),
                )}
              >
                {errored ? <CircleAlert className="mr-1.5 inline size-4 align-[-2px]" aria-hidden="true" /> : null}
                {item.content}
              </div>

              {item.status === 'failed' && item.failure ? (
                <FailureNotice failure={item.failure} onRetry={() => onRetry(item.key)} />
              ) : null}

              {isUser ? null : <TurnCard view={view} services={services} timeZone={timeZone} actions={actions} />}
            </div>
          );
        })}

        <div className={cn('flex items-center gap-2 px-1 text-xs tabular-nums text-muted-foreground', isUser && 'justify-end')}>
          <time dateTime={last.createdAt}>{formatTime(last.createdAt, timeZone)}</time>
          {last.status === 'pending' ? <span>· Sending…</span> : null}
          {!isUser && last.engine && isLanguageEngine(last.engine) ? <EngineBadge engine={last.engine} /> : null}
        </div>
      </div>
    </div>
  );
}
