import { describe, expect, it } from 'vitest';
import type { ChatItem } from './reducer';
import { groupItems } from './grouping';

const NOW = new Date('2026-10-02T16:00:00.000Z'); // noon in New York
const ZONE = 'America/New_York';

const item = (key: string, role: ChatItem['role'], createdAt: string): ChatItem => ({
  key,
  id: key,
  role,
  content: key,
  engine: null,
  action: null,
  createdAt,
  status: 'sent',
});

describe('groupItems', () => {
  it('folds consecutive messages from one speaker into a single group', () => {
    const blocks = groupItems(
      [
        item('a', 'user', '2026-10-02T15:00:00.000Z'),
        item('b', 'user', '2026-10-02T15:01:00.000Z'),
        item('c', 'assistant', '2026-10-02T15:01:30.000Z'),
      ],
      ZONE,
      NOW,
    );
    expect(blocks.map((block) => (block.kind === 'group' ? block.items.map((i) => i.key) : block.label))).toEqual([
      'Today',
      ['a', 'b'],
      ['c'],
    ]);
  });

  it('starts a new group after a long pause, even from the same speaker', () => {
    const groups = groupItems(
      [item('a', 'user', '2026-10-02T14:00:00.000Z'), item('b', 'user', '2026-10-02T14:30:00.000Z')],
      ZONE,
      NOW,
    ).filter((block) => block.kind === 'group');
    expect(groups).toHaveLength(2);
  });

  it('inserts a day divider using the business timezone, not UTC', () => {
    // 02:00 UTC on Oct 2 is still the evening of Oct 1 in New York.
    const labels = groupItems(
      [item('a', 'user', '2026-10-02T02:00:00.000Z'), item('b', 'assistant', '2026-10-02T15:00:00.000Z')],
      ZONE,
      NOW,
    )
      .filter((block) => block.kind === 'day')
      .map((block) => block.label);
    expect(labels).toEqual(['Yesterday', 'Today']);
  });

  it('labels older days with a date', () => {
    const [day] = groupItems([item('a', 'user', '2026-09-20T15:00:00.000Z')], ZONE, NOW);
    expect(day).toMatchObject({ kind: 'day', label: 'Sep 20, 2026' });
  });

  it('returns nothing for an empty transcript', () => {
    expect(groupItems([], ZONE, NOW)).toEqual([]);
  });
});
