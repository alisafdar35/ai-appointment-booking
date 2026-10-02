import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ChatTranscript } from '@/lib/api';
import { queryKeys } from '@/lib/queries';
import { COMPLETE_DRAFT, SESSION_ID, message, session, turn } from '../test/factories';
import { mirrorTurnIntoTranscriptCache } from './cache';

const seeded = () => {
  const client = new QueryClient();
  const transcript: ChatTranscript = { session: session(), messages: [message({ id: '1', role: 'user' })] };
  client.setQueryData(queryKeys.chat.transcript(SESSION_ID), transcript);
  return client;
};
const read = (client: QueryClient) => client.getQueryData<ChatTranscript>(queryKeys.chat.transcript(SESSION_ID))!;

describe('mirrorTurnIntoTranscriptCache', () => {
  it('appends the assistant message and mirrors the draft', () => {
    const client = seeded();
    mirrorTurnIntoTranscriptCache(client, turn({ messageId: '2', bookingDraft: COMPLETE_DRAFT }));
    expect(read(client).messages.map((m) => m.id)).toEqual(['1', '2']);
    expect(read(client).session.bookingDraft).toEqual(COMPLETE_DRAFT);
  });

  it('is idempotent: the socket echo of our own turn changes nothing', () => {
    const client = seeded();
    const reply = turn({ messageId: '2' });
    mirrorTurnIntoTranscriptCache(client, reply);
    mirrorTurnIntoTranscriptCache(client, reply);
    expect(read(client).messages).toHaveLength(2);
  });

  it('marks the session completed on a booking', () => {
    const client = seeded();
    mirrorTurnIntoTranscriptCache(client, turn({ action: 'booked' }));
    expect(read(client).session.status).toBe('completed');
  });

  it('does not invent a cache entry for a conversation that was never loaded', () => {
    const client = new QueryClient();
    mirrorTurnIntoTranscriptCache(client, turn());
    expect(client.getQueryData(queryKeys.chat.transcript(SESSION_ID))).toBeUndefined();
  });
});
