import { EMPTY_SLOTS } from '@appt/shared';
import { describe, expect, it } from 'vitest';
import { COMPLETE_DRAFT, appointment } from '../test/factories';
import type { ChatItem } from './reducer';
import { liveItemKey, turnMetaFor, type TurnContext } from './turn-meta';

const item = (key: string, role: ChatItem['role']): ChatItem => ({
  key,
  id: key,
  role,
  content: key,
  engine: null,
  action: null,
  createdAt: '2026-10-02T13:00:00.000Z',
  status: 'sent',
});

describe('liveItemKey', () => {
  it('is the last message when it is the assistant’s', () => {
    expect(liveItemKey([item('u', 'user'), item('a', 'assistant')])).toBe('a');
  });

  it('is null once the user has spoken after the assistant', () => {
    expect(liveItemKey([item('a', 'assistant'), item('u', 'user')])).toBeNull();
  });

  it('is null for an empty conversation', () => {
    expect(liveItemKey([])).toBeNull();
  });
});

describe('turnMetaFor', () => {
  const context = (overrides: Partial<TurnContext> = {}): TurnContext => ({ turns: {}, appointments: [], ...overrides });
  const reply = (overrides: Partial<ChatItem> = {}): ChatItem => ({ ...item('a', 'assistant'), ...overrides });

  it('prefers the turn this tab received', () => {
    const received = { action: 'confirm' as const, missing: [], bookingDraft: COMPLETE_DRAFT };
    expect(turnMetaFor(reply({ action: 'collect_info', draft: EMPTY_SLOTS }), context({ turns: { a: received } }))).toBe(received);
  });

  it('rebuilds a reply from the draft stored with it', () => {
    const shown = { ...COMPLETE_DRAFT, time: '10:00' };
    const meta = turnMetaFor(reply({ action: 'confirm', draft: shown }), context());
    expect(meta).toMatchObject({ action: 'confirm', bookingDraft: shown, missing: [] });
  });

  it('restores the suggested times and the clarifying choice recorded with the reply', () => {
    const suggestions = [{ date: '2026-10-05', time: '15:00', label: '3:00 PM' }];
    const clarification = { field: 'date' as const, options: ['2027-03-04', '2027-04-03'] };
    const meta = turnMetaFor(reply({ action: 'collect_info', draft: EMPTY_SLOTS, suggestions, clarification }), context());
    expect(meta).toMatchObject({ suggestions, clarification, missing: ['serviceName', 'date', 'time'] });
  });

  it('trusts the recorded action over what the draft would suggest', () => {
    expect(turnMetaFor(reply({ action: 'collect_info', draft: COMPLETE_DRAFT }), context())?.action).toBe('collect_info');
  });

  it('is nothing for a user message', () => {
    expect(turnMetaFor(item('u', 'user'), context())).toBeNull();
  });

  describe('a booked reply', () => {
    const booked = appointment();

    it('shows the appointment it names, from the transcript’s bookings', () => {
      const other = appointment({ id: 'other' });
      const meta = turnMetaFor(
        reply({ action: 'booked', draft: COMPLETE_DRAFT, appointmentId: booked.id }),
        context({ appointments: [other, booked] }),
      );
      expect(meta).toMatchObject({ action: 'booked', appointment: booked, bookingDraft: COMPLETE_DRAFT });
    });

    it('has no appointment once it is cancelled (gone from the transcript), keeping its draft', () => {
      const meta = turnMetaFor(reply({ action: 'booked', draft: COMPLETE_DRAFT, appointmentId: booked.id }), context());
      expect(meta).toMatchObject({ action: 'booked', appointment: undefined, bookingDraft: COMPLETE_DRAFT });
    });
  });
});
