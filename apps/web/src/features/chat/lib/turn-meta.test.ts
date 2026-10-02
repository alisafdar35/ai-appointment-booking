import { EMPTY_SLOTS } from '@appt/shared';
import { describe, expect, it } from 'vitest';
import { COMPLETE_DRAFT, SESSION_ID, appointment } from '../test/factories';
import type { ChatItem } from './reducer';
import { findBookedAppointment, liveItemKey, restoreTurnMeta } from './turn-meta';

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

describe('restoreTurnMeta', () => {
  const collecting = { draft: { ...EMPTY_SLOTS, serviceName: 'Routine Checkup' }, status: 'active' as const };

  it('restores the action the server recorded, including an offer of the form', () => {
    expect(restoreTurnMeta({ action: 'needs_form' }, collecting)).toMatchObject({
      action: 'needs_form',
      missing: ['date', 'time'],
      bookingDraft: collecting.draft,
    });
  });

  it('restores the suggested times recorded with the reply', () => {
    const suggestions = [{ date: '2026-10-05', time: '15:00', label: '3:00 PM' }];
    expect(restoreTurnMeta({ action: 'collect_info', suggestions }, collecting).suggestions).toEqual(suggestions);
  });

  it('trusts the recorded action over what the draft would suggest', () => {
    expect(restoreTurnMeta({ action: 'collect_info' }, { draft: COMPLETE_DRAFT, status: 'active' }).action).toBe('collect_info');
  });

  it('attaches the appointment to a recorded booking when it is known', () => {
    const booked = appointment();
    expect(restoreTurnMeta({ action: 'booked' }, { draft: COMPLETE_DRAFT, status: 'completed' }, booked)).toMatchObject({
      action: 'booked',
      appointment: booked,
    });
  });

  describe('for a message stored before actions were recorded', () => {
    it('infers a confirmation from a complete draft', () => {
      expect(restoreTurnMeta({ action: null }, { draft: COMPLETE_DRAFT, status: 'active' }).action).toBe('confirm');
    });

    it('infers collecting from an incomplete draft', () => {
      expect(restoreTurnMeta({ action: null }, collecting).action).toBe('collect_info');
    });

    it('infers a booking from a completed session', () => {
      expect(restoreTurnMeta({ action: null }, { draft: COMPLETE_DRAFT, status: 'completed' }).action).toBe('booked');
    });
  });
});

describe('findBookedAppointment', () => {
  it('finds the live appointment that points back at the session', () => {
    const mine = appointment();
    const other = appointment({ id: 'other', chatSessionId: 'another-session' });
    expect(findBookedAppointment(SESSION_ID, [other, mine])).toBe(mine);
  });

  it('ignores a cancelled one, and a missing session', () => {
    expect(findBookedAppointment(SESSION_ID, [appointment({ status: 'cancelled' })])).toBeUndefined();
    expect(findBookedAppointment(null, [appointment()])).toBeUndefined();
  });
});
