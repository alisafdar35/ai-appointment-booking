import type { ServiceDto } from '@appt/shared';
import { useMemo } from 'react';
import { groupItems } from '../lib/grouping';
import { liveItemKey, turnMetaFor, type TurnContext } from '../lib/turn-meta';
import type { ChatItem } from '../lib/reducer';
import { MessageGroup } from './MessageGroup';
import type { MessageView, TurnActions } from './TurnCard';

interface MessageListProps {
  items: ChatItem[];
  /** What each assistant message's card is rebuilt from when this tab did not receive its turn. */
  context: TurnContext;
  services: readonly ServiceDto[];
  timeZone: string;
  actions: TurnActions;
  onRetry: (clientKey: string) => void;
}

/**
 * The transcript. `role="log"` with polite announcements, so a screen reader
 * hears each new message without being interrupted mid-sentence, and only
 * additions are announced (not the retry/sent status churn on older bubbles).
 */
export function MessageList({ items, context, services, timeZone, actions, onRetry }: MessageListProps) {
  const blocks = useMemo(() => groupItems(items, timeZone), [items, timeZone]);
  const liveKey = liveItemKey(items);

  const viewOf = (item: ChatItem): MessageView => {
    const live = item.key === liveKey;
    return { item, live, meta: turnMetaFor(item, live, context) };
  };

  return (
    <div role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation" className="space-y-4">
      {blocks.map((block) =>
        block.kind === 'day' ? (
          <p key={block.key} className="py-1 text-center text-xs font-medium text-muted-foreground">
            {block.label}
          </p>
        ) : (
          <MessageGroup
            key={block.key}
            role={block.role}
            views={block.items.map(viewOf)}
            services={services}
            timeZone={timeZone}
            actions={actions}
            onRetry={onRetry}
          />
        ),
      )}
    </div>
  );
}
