import type { ServiceDto } from '@appt/shared';
import { useMemo } from 'react';
import { groupItems } from '../lib/grouping';
import { liveItemKey } from '../lib/turn-meta';
import type { ChatItem, TurnMeta } from '../lib/reducer';
import { MessageGroup } from './MessageGroup';
import type { MessageView, TurnActions } from './TurnCard';

interface MessageListProps {
  items: ChatItem[];
  /** Turn payloads this tab has seen, by assistant message id. */
  turns: Record<string, TurnMeta>;
  /** What to render for the newest assistant message when `turns` has no entry for it (e.g. after a reload). */
  restoredMeta: TurnMeta | null;
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
export function MessageList({ items, turns, restoredMeta, services, timeZone, actions, onRetry }: MessageListProps) {
  const blocks = useMemo(() => groupItems(items, timeZone), [items, timeZone]);
  const liveKey = liveItemKey(items);

  const viewOf = (item: ChatItem): MessageView => {
    const live = item.key === liveKey;
    const recorded = item.id ? turns[item.id] : undefined;
    return { item, live, meta: recorded ?? (live ? restoredMeta : null) };
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
