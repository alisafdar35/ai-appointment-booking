import { EMPTY_SLOTS } from '@appt/shared';
import { describe, expect, it } from 'vitest';
import { COMPLETE_DRAFT, SESSION_ID, appointment, message, session, turn } from '../test/factories';
import {
  NEW_SESSION_KEY,
  chatReducer,
  initialChatState,
  type ChatAction,
  type ChatState,
  type SendFailure,
} from './reducer';

const run = (actions: ChatAction[], from: ChatState = initialChatState) => actions.reduce(chatReducer, from);

const send = (clientId: string, content = 'hello', sessionKey: string = SESSION_ID): ChatAction => ({
  type: 'send',
  sessionKey,
  clientId,
  content,
  createdAt: '2026-10-02T13:00:00.000Z',
});

const FAILURE: SendFailure = { message: "Couldn't reach the server.", failedAt: 1 };

describe('optimistic append', () => {
  it('shows the user message immediately as pending, without a server id', () => {
    const state = run([send('local-1', 'Book a checkup')]);
    expect(state.sessions[SESSION_ID]?.items).toEqual([
      expect.objectContaining({ key: 'local-1', id: null, role: 'user', content: 'Book a checkup', status: 'pending' }),
    ]);
  });

  it('creates the conversation state on first send, under the draft key', () => {
    const state = run([send('local-1', 'hi', NEW_SESSION_KEY)]);
    expect(Object.keys(state.sessions)).toEqual([NEW_SESSION_KEY]);
  });
});

describe('reconciling with the server turn', () => {
  it('marks the optimistic message sent, appends the reply and mirrors the draft', () => {
    const reply = turn({ messageId: '2', bookingDraft: COMPLETE_DRAFT, action: 'confirm', missing: [] });
    const state = run([send('local-1'), { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: reply }]);
    const current = state.sessions[SESSION_ID]!;

    expect(current.items.map((item) => [item.key, item.status, item.role])).toEqual([
      ['local-1', 'sent', 'user'],
      ['message-2', 'sent', 'assistant'],
    ]);
    expect(current.draft).toEqual(COMPLETE_DRAFT);
    expect(current.turns['2']).toMatchObject({ action: 'confirm', bookingDraft: COMPLETE_DRAFT });
    expect(current.lastTurnId).toBe('2');
  });

  it('moves a draft conversation under the id the server assigned', () => {
    const state = run([
      send('local-1', 'hi', NEW_SESSION_KEY),
      { type: 'turn', sessionKey: NEW_SESSION_KEY, clientId: 'local-1', turn: turn() },
    ]);
    expect(Object.keys(state.sessions)).toEqual([SESSION_ID]);
    expect(state.sessions[SESSION_ID]?.items).toHaveLength(2);
  });

  it('marks the conversation completed when the turn is a booking', () => {
    const booked = turn({ action: 'booked', appointment: appointment(), bookingDraft: COMPLETE_DRAFT, missing: [] });
    const state = run([send('local-1'), { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: booked }]);
    expect(state.sessions[SESSION_ID]?.status).toBe('completed');
    expect(state.sessions[SESSION_ID]?.turns['2']?.appointment?.id).toBe(appointment().id);
  });

  it('takes the stored id of our message from the turn, keeping the bubble’s key', () => {
    const reply = turn({ userMessageId: '41', userContent: 'Book a checkup', messageId: '42' });
    const state = run([send('local-1', 'Book a checkup'), { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: reply }]);
    expect(state.sessions[SESSION_ID]?.items[0]).toMatchObject({ key: 'local-1', id: '41', status: 'sent' });
  });

  it('pairs identical messages with their own turns by id, never by text', () => {
    const open = run([{ type: 'hydrate', session: session(), messages: [message({ id: '1', role: 'user', content: 'yes' })] }]);
    const state = run(
      [
        send('local-2', 'yes'),
        { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-2', turn: turn({ userMessageId: '3', userContent: 'yes', messageId: '4' }) },
      ],
      open,
    );
    expect(state.sessions[SESSION_ID]?.items.map((item) => [item.key, item.id])).toEqual([
      ['message-1', '1'],
      ['local-2', '3'],
      ['message-4', '4'],
    ]);
  });

  it('adds the stored user message of a form submission, which no bubble stood in for', () => {
    const submitted = turn({ userMessageId: '5', userContent: 'Book Routine Checkup on Monday, October 5 at 2:00 PM.', messageId: '6' });
    const state = run([{ type: 'turn', sessionKey: SESSION_ID, turn: submitted }]);
    expect(state.sessions[SESSION_ID]?.items.map((item) => [item.role, item.id])).toEqual([
      ['user', '5'],
      ['assistant', '6'],
    ]);
  });

  it('records the server’s action and suggestions on the reply', () => {
    const suggestions = [{ date: '2026-10-05', time: '15:00', label: '3:00 PM' }];
    const state = run([send('local-1'), { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: turn({ suggestions }) }]);
    expect(state.sessions[SESSION_ID]?.items[1]).toMatchObject({ action: 'collect_info', suggestions });
  });

  it('adopts a session created ahead of any message (the form path)', () => {
    const state = run([
      send('local-1', 'hi', NEW_SESSION_KEY),
      { type: 'session_created', sessionId: SESSION_ID },
    ]);
    expect(Object.keys(state.sessions)).toEqual([SESSION_ID]);
  });
});

describe('failure and retry', () => {
  it('keeps the text and records why it failed', () => {
    const state = run([send('local-1', 'Book a checkup'), { type: 'failed', sessionKey: SESSION_ID, clientId: 'local-1', failure: FAILURE }]);
    expect(state.sessions[SESSION_ID]?.items[0]).toMatchObject({
      content: 'Book a checkup',
      status: 'failed',
      failure: FAILURE,
    });
  });

  it('retry flips the same message back to pending and clears the failure', () => {
    const state = run([
      send('local-1'),
      { type: 'failed', sessionKey: SESSION_ID, clientId: 'local-1', failure: FAILURE },
      { type: 'retry', sessionKey: SESSION_ID, clientId: 'local-1' },
    ]);
    const items = state.sessions[SESSION_ID]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'local-1', status: 'pending', failure: undefined });
  });

  it('a retry that succeeds ends up sent, with exactly one reply', () => {
    const state = run([
      send('local-1'),
      { type: 'failed', sessionKey: SESSION_ID, clientId: 'local-1', failure: FAILURE },
      { type: 'retry', sessionKey: SESSION_ID, clientId: 'local-1' },
      { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: turn() },
    ]);
    expect(state.sessions[SESSION_ID]?.items.map((item) => item.status)).toEqual(['sent', 'sent']);
  });
});

describe('de-duplication', () => {
  it('ignores the socket echo of a turn the HTTP response already delivered', () => {
    const reply = turn();
    const state = run([
      send('local-1'),
      { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: reply },
      { type: 'push', turn: reply },
    ]);
    expect(state.sessions[SESSION_ID]?.items.filter((item) => item.role === 'assistant')).toHaveLength(1);
  });

  it('is not doubled when the socket delivers the turn before the HTTP response', () => {
    const reply = turn();
    const state = run([
      send('local-1'),
      { type: 'push', turn: reply },
      { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: reply },
    ]);
    const items = state.sessions[SESSION_ID]!.items;
    expect(items.map((item) => item.role)).toEqual(['user', 'assistant']);
    expect(items[0]?.status).toBe('sent');
  });

  it('ignores a pushed turn for a conversation this tab has not opened', () => {
    expect(run([{ type: 'push', turn: turn() }])).toBe(initialChatState);
  });

  it('applies a pushed turn to an open conversation', () => {
    const open = run([{ type: 'hydrate', session: session(), messages: [message({ id: '1', role: 'user' })] }]);
    const state = run([{ type: 'push', turn: turn() }], open);
    expect(state.sessions[SESSION_ID]?.items.map((item) => item.id)).toEqual(['1', '2']);
  });

  it('shows both halves of a turn another tab produced: the question, then the reply', () => {
    const open = run([{ type: 'hydrate', session: session(), messages: [] }]);
    const state = run([{ type: 'push', turn: turn({ userMessageId: '7', userContent: 'From my phone', messageId: '8' }) }], open);
    expect(state.sessions[SESSION_ID]?.items.map((item) => [item.role, item.content])).toEqual([
      ['user', 'From my phone'],
      ['assistant', 'Which day would you like to come in?'],
    ]);
  });

  it('leaves a push to the HTTP response while this tab has a send in flight there', () => {
    const sending = run([send('local-1', 'hello')]);
    expect(run([{ type: 'push', turn: turn() }], sending)).toBe(sending);
  });
});

describe('a conversation that closed elsewhere', () => {
  it('is marked completed, and a transcript fetched before the booking does not reopen it', () => {
    const closed = run([send('local-1'), { type: 'closed', sessionKey: SESSION_ID }]);
    expect(closed.sessions[SESSION_ID]?.status).toBe('completed');
    expect(run([{ type: 'hydrate', session: session({ status: 'active' }), messages: [] }], closed).sessions[SESSION_ID]?.status).toBe(
      'completed',
    );
  });

  it('lets a refused message be discarded once it has moved to a new conversation', () => {
    const state = run([send('local-1'), { type: 'discard', sessionKey: SESSION_ID, clientId: 'local-1' }]);
    expect(state.sessions[SESSION_ID]?.items).toEqual([]);
  });
});

describe('hydrating from the transcript', () => {
  const serverMessages = [
    message({ id: '1', role: 'user', content: 'Book a checkup' }),
    message({ id: '2', role: 'assistant', content: 'Which day?' }),
  ];

  it('builds the conversation from the server transcript and takes its draft and status', () => {
    const state = run([
      {
        type: 'hydrate',
        session: session({ status: 'completed', bookingDraft: COMPLETE_DRAFT }),
        messages: serverMessages,
      },
    ]);
    const current = state.sessions[SESSION_ID]!;
    expect(current.items.map((item) => [item.id, item.status])).toEqual([
      ['1', 'sent'],
      ['2', 'sent'],
    ]);
    expect(current.draft).toEqual(COMPLETE_DRAFT);
    expect(current.status).toBe('completed');
    expect(current.hydrated).toBe(true);
  });

  it('drops system and tool rows', () => {
    const state = run([
      { type: 'hydrate', session: session(), messages: [...serverMessages, message({ id: '3', role: 'tool' })] },
    ]);
    expect(state.sessions[SESSION_ID]?.items).toHaveLength(2);
  });

  it('gives the server copy of our own message the optimistic message’s key, so the bubble does not remount', () => {
    const state = run([
      send('local-1', 'Book a checkup'),
      { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: turn({ messageId: '2' }) },
      { type: 'hydrate', session: session(), messages: serverMessages },
    ]);
    const items = state.sessions[SESSION_ID]!.items;
    expect(items.map((item) => [item.key, item.id])).toEqual([
      ['local-1', '1'],
      ['message-2', '2'],
    ]);
  });

  it('holds back the server’s copy of a message still in flight, so it is never shown twice', () => {
    const earlier = message({ id: '0', role: 'assistant', content: 'Hello!' });
    const state = run([
      send('local-1', 'Book a checkup'),
      // Fetched after the message was stored but before its turn came back.
      { type: 'hydrate', session: session(), messages: [earlier, serverMessages[0]!, serverMessages[1]!] },
    ]);
    expect(state.sessions[SESSION_ID]?.items.map((item) => [item.key, item.id, item.status])).toEqual([
      ['message-0', '0', 'sent'],
      ['local-1', null, 'pending'],
    ]);
  });

  it('brings in what it held back once the turn has named our message', () => {
    const state = run([
      send('local-1', 'Book a checkup'),
      { type: 'hydrate', session: session(), messages: [serverMessages[0]!] },
      { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: turn({ messageId: '2' }) },
      { type: 'hydrate', session: session(), messages: serverMessages },
    ]);
    expect(state.sessions[SESSION_ID]?.items.map((item) => [item.key, item.id])).toEqual([
      ['local-1', '1'],
      ['message-2', '2'],
    ]);
  });

  it('carries each message’s recorded action and suggestions onto its item', () => {
    const suggestions = [{ date: '2026-10-05', time: '15:00', label: '3:00 PM' }];
    const state = run([
      {
        type: 'hydrate',
        session: session(),
        messages: [serverMessages[0]!, message({ id: '2', role: 'assistant', action: 'needs_form', suggestions })],
      },
    ]);
    expect(state.sessions[SESSION_ID]?.items.map((item) => [item.action, item.suggestions])).toEqual([
      [null, undefined],
      ['needs_form', suggestions],
    ]);
  });

  it('keeps a failed message, after the messages that preceded it', () => {
    const state = run([
      send('local-1', 'this one failed'),
      { type: 'failed', sessionKey: SESSION_ID, clientId: 'local-1', failure: FAILURE },
      { type: 'hydrate', session: session(), messages: serverMessages },
    ]);
    expect(state.sessions[SESSION_ID]?.items.map((item) => item.key)).toEqual(['local-1', 'message-1', 'message-2']);
  });

  it('puts our unacknowledged message before its reply when the cache has the reply but not the message', () => {
    const state = run([
      send('local-1', 'Book a checkup'),
      { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: turn({ messageId: '2' }) },
      // The transcript cache was written with the assistant's reply only.
      { type: 'hydrate', session: session(), messages: [serverMessages[1]!] },
    ]);
    expect(state.sessions[SESSION_ID]?.items.map((item) => item.role)).toEqual(['user', 'assistant']);
  });

  it('does not roll the draft back when the transcript predates the latest turn', () => {
    const reply = turn({ messageId: '4', bookingDraft: COMPLETE_DRAFT, action: 'confirm', missing: [] });
    const state = run([
      send('local-1'),
      { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: reply },
      { type: 'hydrate', session: session({ bookingDraft: EMPTY_SLOTS }), messages: serverMessages },
    ]);
    expect(state.sessions[SESSION_ID]?.draft).toEqual(COMPLETE_DRAFT);
    expect(state.sessions[SESSION_ID]?.items.map((item) => item.id)).toContain('4');
  });

  it('keeps each turn payload across a hydrate', () => {
    const state = run([
      send('local-1'),
      { type: 'turn', sessionKey: SESSION_ID, clientId: 'local-1', turn: turn({ messageId: '2', action: 'needs_form' }) },
      { type: 'hydrate', session: session(), messages: serverMessages },
    ]);
    expect(state.sessions[SESSION_ID]?.turns['2']?.action).toBe('needs_form');
  });
});

describe('remote typing', () => {
  it('sets and clears the flag for an open conversation, and ignores unknown ones', () => {
    const open = run([send('local-1')]);
    const typing = run([{ type: 'typing', sessionId: SESSION_ID, typing: true }], open);
    expect(typing.sessions[SESSION_ID]?.remoteTyping).toBe(true);
    expect(run([{ type: 'typing', sessionId: SESSION_ID, typing: false }], typing).sessions[SESSION_ID]?.remoteTyping).toBe(false);
    expect(run([{ type: 'typing', sessionId: 'other', typing: true }], open)).toBe(open);
  });

  it('clears when the turn arrives', () => {
    const state = run([
      { type: 'hydrate', session: session(), messages: [] },
      { type: 'typing', sessionId: SESSION_ID, typing: true },
      { type: 'push', turn: turn() },
    ]);
    expect(state.sessions[SESSION_ID]?.remoteTyping).toBe(false);
  });
});
