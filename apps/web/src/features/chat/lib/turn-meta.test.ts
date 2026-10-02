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
  const collectingDraft = { ...EMPTY_SLOTS, serviceName: 'Routine Checkup' };
  const context = (overrides: Partial<TurnContext> = {}): TurnContext => ({
    turns: {},
    draft: collectingDraft,
    status: 'active',
    appointments: [],
    ...overrides,
  });
  const reply = (overrides: Partial<ChatItem> = {}): ChatItem => ({ ...item('a', 'assistant'), ...overrides });

  it('prefers the turn this tab received', () => {
    const received = { action: 'confirm' as const, missing: [], bookingDraft: COMPLETE_DRAFT };
    expect(turnMetaFor(reply({ action: 'collect_info' }), false, context({ turns: { a: received } }))).toBe(received);
  });

  it('rebuilds an earlier reply from the draft stored with it, not the session’s current one', () => {
    const shown = { ...COMPLETE_DRAFT, time: '10:00' };
    const meta = turnMetaFor(reply({ action: 'confirm', draft: shown }), false, context({ draft: COMPLETE_DRAFT }));
    expect(meta).toMatchObject({ action: 'confirm', bookingDraft: shown, missing: [] });
  });

  it('gives an earlier reply stored without a draft no card, rather than one built from today’s draft', () => {
    expect(turnMetaFor(reply({ action: 'confirm' }), false, context({ draft: COMPLETE_DRAFT }))).toBeNull();
  });

  it('uses the session’s draft for the latest reply stored without one', () => {
    expect(turnMetaFor(reply({ action: 'needs_form' }), true, context())).toMatchObject({
      action: 'needs_form',
      missing: ['date', 'time'],
      bookingDraft: collectingDraft,
    });
  });

  it('restores the suggested times recorded with the reply', () => {
    const suggestions = [{ date: '2026-10-05', time: '15:00', label: '3:00 PM' }];
    expect(turnMetaFor(reply({ action: 'collect_info', suggestions }), true, context())?.suggestions).toEqual(suggestions);
  });

  it('trusts the recorded action over what the draft would suggest', () => {
    expect(turnMetaFor(reply({ action: 'collect_info' }), true, context({ draft: COMPLETE_DRAFT }))?.action).toBe('collect_info');
  });

  it('is nothing for a user message', () => {
    expect(turnMetaFor(item('u', 'user'), false, context())).toBeNull();
  });

  describe('a booked reply', () => {
    const booked = appointment();

    it('shows the appointment it names, from the transcript’s bookings', () => {
      const other = appointment({ id: 'other' });
      const meta = turnMetaFor(
        reply({ action: 'booked', draft: COMPLETE_DRAFT, appointmentId: booked.id }),
        true,
        context({ status: 'completed', appointments: [other, booked] }),
      );
      expect(meta).toMatchObject({ action: 'booked', appointment: booked, bookingDraft: COMPLETE_DRAFT });
    });

    it('has no appointment once it is cancelled (gone from the transcript), keeping its draft', () => {
      const meta = turnMetaFor(reply({ action: 'booked', draft: COMPLETE_DRAFT, appointmentId: booked.id }), true, context());
      expect(meta).toMatchObject({ action: 'booked', appointment: undefined, bookingDraft: COMPLETE_DRAFT });
    });

    it('stored before it named its appointment, takes the conversation’s one booking', () => {
      const meta = turnMetaFor(reply({ action: 'booked' }), true, context({ draft: COMPLETE_DRAFT, status: 'completed', appointments: [booked] }));
      expect(meta?.appointment).toBe(booked);
    });
  });

  describe('for the latest message stored before actions were recorded', () => {
    it('infers a confirmation from a complete draft', () => {
      expect(turnMetaFor(reply(), true, context({ draft: COMPLETE_DRAFT }))?.action).toBe('confirm');
    });

    it('infers collecting from an incomplete draft', () => {
      expect(turnMetaFor(reply(), true, context())?.action).toBe('collect_info');
    });

    it('infers a booking from a completed session', () => {
      expect(turnMetaFor(reply(), true, context({ draft: COMPLETE_DRAFT, status: 'completed' }))?.action).toBe('booked');
    });

    it('infers nothing for an older one', () => {
      expect(turnMetaFor(reply(), false, context({ draft: COMPLETE_DRAFT }))).toBeNull();
    });
  });
});
