import { addDays, dateInZone, formatDate } from '@/lib/datetime';
import type { ChatItem } from './reducer';

export type MessageBlock =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'group'; key: string; role: ChatItem['role']; items: ChatItem[] };

/** Messages further apart than this start a new group, so a gap in the conversation is visible. */
const GROUP_GAP_MS = 5 * 60_000;

function dayLabel(date: string, today: string, timeZone: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return formatDate(date, timeZone, 'medium');
}

/**
 * Arrange a flat transcript for display: a day divider whenever the calendar
 * day changes (in the business timezone), and consecutive messages from the
 * same speaker folded into one group that shares an avatar, a timestamp and a
 * run of tightly spaced bubbles.
 */
export function groupItems(items: readonly ChatItem[], timeZone: string, now: Date = new Date()): MessageBlock[] {
  const today = dateInZone(now, timeZone);
  const blocks: MessageBlock[] = [];
  let lastDay: string | null = null;
  let lastAt = 0;

  for (const item of items) {
    const day = dateInZone(item.createdAt, timeZone);
    const at = Date.parse(item.createdAt);

    if (day !== lastDay) {
      blocks.push({ kind: 'day', key: `day-${day}`, label: dayLabel(day, today, timeZone) });
      lastDay = day;
    }

    const previous = blocks[blocks.length - 1];
    const continuesGroup =
      previous?.kind === 'group' && previous.role === item.role && at - lastAt <= GROUP_GAP_MS;

    if (continuesGroup) {
      previous.items.push(item);
    } else {
      blocks.push({ kind: 'group', key: `group-${item.key}`, role: item.role, items: [item] });
    }
    lastAt = at;
  }

  return blocks;
}
