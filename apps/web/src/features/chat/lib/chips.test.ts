import { EMPTY_SLOTS, bookingSlotsSchema, sendMessageSchema } from '@appt/shared';
import { describe, expect, it } from 'vitest';
import { CHECKUP, WHITENING } from '../test/factories';
import { buildStarterPrompts, deriveQuickReplies } from './chips';
import { MESSAGE_MAX_LENGTH } from './constants';
import { NOTES_MAX_LENGTH } from './fallback-form';

const context = {
  draft: EMPTY_SLOTS,
  services: [CHECKUP, WHITENING],
  today: '2026-10-02',
  timeZone: 'America/New_York',
};

describe('deriveQuickReplies', () => {
  it('offers the catalogue when the service is missing', () => {
    const replies = deriveQuickReplies({
      ...context,
      meta: { action: 'collect_info', missing: ['serviceName', 'date', 'time'] },
    });
    expect(replies.map((reply) => reply.label)).toEqual(['Routine Checkup', 'Teeth Whitening']);
    // The chip says exactly the service name, which both engines resolve against the catalogue.
    expect(replies.map((reply) => reply.message)).toEqual(['Routine Checkup', 'Teeth Whitening']);
  });

  it('offers rough times of day when date and time are both missing', () => {
    const replies = deriveQuickReplies({
      ...context,
      draft: { ...EMPTY_SLOTS, serviceName: 'Routine Checkup' },
      meta: { action: 'collect_info', missing: ['date', 'time'] },
    });
    expect(replies.map((reply) => reply.message)).toEqual(['tomorrow morning', 'tomorrow afternoon']);
  });

  it('offers the next days, relative to the business date, when only the date is missing', () => {
    const replies = deriveQuickReplies({
      ...context,
      draft: { ...EMPTY_SLOTS, serviceName: 'Routine Checkup', time: '14:00' },
      meta: { action: 'collect_info', missing: ['date'] },
    });
    expect(replies.map((reply) => reply.label)).toEqual(['Tomorrow', 'Sun, Oct 4', 'Mon, Oct 5']);
    expect(replies.map((reply) => reply.message)).toEqual(['tomorrow', 'Oct 4, 2026', 'Oct 5, 2026']);
  });

  it('offers working-hour times when only the time is missing', () => {
    const replies = deriveQuickReplies({
      ...context,
      draft: { ...EMPTY_SLOTS, serviceName: 'Routine Checkup', date: '2026-10-05' },
      meta: { action: 'collect_info', missing: ['time'] },
    });
    expect(replies.map((reply) => reply.label)).toEqual(['9:00 AM', '11:00 AM', '2:00 PM', '4:00 PM']);
    expect(replies.map((reply) => reply.message)).toEqual(['9am', '11am', '2pm', '4pm']);
  });

  it('prefers the server’s suggested slots when a time was taken, naming the date unambiguously', () => {
    const replies = deriveQuickReplies({
      ...context,
      draft: { serviceName: 'Routine Checkup', date: '2026-10-05', time: null, notes: null },
      meta: {
        action: 'collect_info',
        missing: ['time'],
        suggestions: [
          { date: '2026-10-05', time: '15:00', label: '3:00 PM' },
          { date: '2026-10-06', time: '09:30', label: '2026-10-06 at 9:30 AM' },
        ],
      },
    });
    expect(replies.map((reply) => reply.label)).toEqual(['3:00 PM', 'Tue, Oct 6 · 9:30 AM']);
    expect(replies.map((reply) => reply.message)).toEqual(['Oct 5, 2026 at 3:00 PM', 'Oct 6, 2026 at 9:30 AM']);
  });

  it.each(['confirm', 'booked', 'needs_form', 'error'] as const)('offers nothing for %s', (action) => {
    expect(deriveQuickReplies({ ...context, meta: { action, missing: ['date'] } })).toEqual([]);
  });

  it('offers nothing when nothing is missing', () => {
    expect(deriveQuickReplies({ ...context, meta: { action: 'collect_info', missing: [] } })).toEqual([]);
  });
});

describe('buildStarterPrompts', () => {
  it('names the business’s own services', () => {
    const prompts = buildStarterPrompts([CHECKUP, WHITENING]);
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toBe('Book Routine Checkup tomorrow at 2pm');
    expect(prompts[1]).toContain('Teeth Whitening');
  });

  it('falls back to generic prompts before the catalogue loads', () => {
    const prompts = buildStarterPrompts([]);
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toBe('Book a routine checkup tomorrow at 2pm');
  });

  it('still returns four prompts for a one-service business', () => {
    expect(buildStarterPrompts([CHECKUP])).toHaveLength(4);
  });
});

describe('limits mirrored from @appt/shared', () => {
  it('matches the message length the API accepts', () => {
    expect(sendMessageSchema.safeParse({ content: 'a'.repeat(MESSAGE_MAX_LENGTH) }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ content: 'a'.repeat(MESSAGE_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it('matches the notes length the draft accepts', () => {
    expect(bookingSlotsSchema.safeParse({ notes: 'a'.repeat(NOTES_MAX_LENGTH) }).success).toBe(true);
    expect(bookingSlotsSchema.safeParse({ notes: 'a'.repeat(NOTES_MAX_LENGTH + 1) }).success).toBe(false);
  });
});
