import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { AppointmentDto } from '@appt/shared';
import type { ChatTranscript } from '@/lib/api';
import { appointmentMatchesFilters, upsertAppointmentInCaches, upsertIntoList } from './appointment-cache';
import { queryKeys } from './keys';

const now = new Date('2026-10-05T12:00:00Z');

function appointment(id: string, startsAt: string, status: AppointmentDto['status'] = 'confirmed'): AppointmentDto {
  return {
    id,
    status,
    source: 'form',
    startsAt,
    endsAt: startsAt,
    notes: null,
    cancellationReason: null,
    chatSessionId: null,
    createdAt: '2026-10-01T00:00:00Z',
    service: { id: 'svc-1', name: 'Cleaning', description: null, durationMinutes: 30, priceCents: 9000 },
    customer: { id: 'u-1', fullName: 'Casey Customer', email: 'casey@example.test' },
  };
}

const past = appointment('a', '2026-10-01T15:00:00Z');
const soon = appointment('b', '2026-10-06T15:00:00Z');
const later = appointment('c', '2026-10-09T15:00:00Z');

describe('appointmentMatchesFilters', () => {
  it('applies the status and window filters the API applies', () => {
    expect(appointmentMatchesFilters(soon, {}, now)).toBe(true);
    expect(appointmentMatchesFilters(soon, { window: 'upcoming' }, now)).toBe(true);
    expect(appointmentMatchesFilters(soon, { window: 'past' }, now)).toBe(false);
    expect(appointmentMatchesFilters(past, { window: 'past' }, now)).toBe(true);
    expect(appointmentMatchesFilters(soon, { status: 'cancelled' }, now)).toBe(false);
  });

  it('reads a comma-separated status list the way the API does', () => {
    const active = { status: 'pending,confirmed', window: 'upcoming' } as const;
    expect(appointmentMatchesFilters(soon, active, now)).toBe(true);
    expect(appointmentMatchesFilters({ ...soon, status: 'pending' }, active, now)).toBe(true);
    expect(appointmentMatchesFilters({ ...soon, status: 'cancelled' }, active, now)).toBe(false);
  });
});

describe('upsertIntoList', () => {
  it('inserts newest-first and replaces by id without duplicating', () => {
    const inserted = upsertIntoList([later, past], soon, {}, now);
    expect(inserted.map((a) => a.id)).toEqual(['c', 'b', 'a']);

    const replaced = upsertIntoList(inserted, { ...soon, status: 'cancelled' }, {}, now);
    expect(replaced.map((a) => a.id)).toEqual(['c', 'b', 'a']);
    expect(replaced[1]?.status).toBe('cancelled');
  });

  it('drops an appointment that no longer matches the list filter', () => {
    const cancelled = { ...soon, status: 'cancelled' as const };
    expect(upsertIntoList([soon, later], cancelled, { status: 'confirmed' }, now).map((a) => a.id)).toEqual(['c']);
  });

  it('respects the list limit', () => {
    expect(upsertIntoList([later, past], soon, { limit: 2 }, now).map((a) => a.id)).toEqual(['c', 'b']);
  });

  it('keeps an upcoming list soonest first, as the API returns it, so the limit drops the furthest booking', () => {
    const upcoming = { window: 'upcoming', limit: 2 } as const;
    expect(upsertIntoList([soon, later], appointment('d', '2026-10-07T15:00:00Z'), upcoming, now).map((a) => a.id)).toEqual([
      'b',
      'd',
    ]);
  });
});

describe('upsertAppointmentInCaches', () => {
  it('moves a cancellation from the active list to the cancelled one', () => {
    const queryClient = new QueryClient();
    const active = { window: 'upcoming', status: 'pending,confirmed' } as const;
    queryClient.setQueryData(queryKeys.appointments.list(active), [soon, later]);
    queryClient.setQueryData(queryKeys.appointments.list({ status: 'cancelled' }), []);

    upsertAppointmentInCaches(queryClient, { ...soon, status: 'cancelled' });

    expect(queryClient.getQueryData<AppointmentDto[]>(queryKeys.appointments.list(active))?.map((a) => a.id)).toEqual(['c']);
    expect(
      queryClient.getQueryData<AppointmentDto[]>(queryKeys.appointments.list({ status: 'cancelled' }))?.map((a) => a.id),
    ).toEqual(['b']);
  });

  it('updates every matching list, and refreshes availability', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.appointments.list({}), [past]);
    queryClient.setQueryData(queryKeys.appointments.list({ status: 'cancelled' }), []);
    queryClient.setQueryData(queryKeys.availability.forDate('svc-1', '2026-10-06'), { slots: [] });

    upsertAppointmentInCaches(queryClient, soon);
    upsertAppointmentInCaches(queryClient, soon); // the socket echoes events back: must be idempotent

    expect(
      queryClient.getQueryData<AppointmentDto[]>(queryKeys.appointments.list({}))?.map((a) => a.id),
    ).toEqual(['b', 'a']);
    expect(queryClient.getQueryData<AppointmentDto[]>(queryKeys.appointments.list({ status: 'cancelled' }))).toEqual([]);
    expect(queryClient.getQueryState(queryKeys.availability.forDate('svc-1', '2026-10-06'))?.isInvalidated).toBe(true);
  });
});

describe('upsertAppointmentInCaches and the transcript of the conversation that booked it', () => {
  const sessionId = 'session-1';
  const fromChat = { ...soon, chatSessionId: sessionId };
  const transcriptKey = queryKeys.chat.transcript(sessionId);
  const seeded = (appointments: AppointmentDto[]) => {
    const client = new QueryClient();
    const transcript = { session: { id: sessionId }, messages: [], appointments } as unknown as ChatTranscript;
    client.setQueryData(transcriptKey, transcript);
    return client;
  };
  const booked = (client: QueryClient) => client.getQueryData<ChatTranscript>(transcriptKey)!.appointments;

  it('replaces the row, so a receipt shows its status as it is now', () => {
    const client = seeded([fromChat]);
    const moved = { ...fromChat, status: 'pending' as const };
    upsertAppointmentInCaches(client, moved);
    expect(booked(client)).toEqual([moved]);
  });

  it('drops it once cancelled, as the server would', () => {
    const client = seeded([fromChat]);
    upsertAppointmentInCaches(client, { ...fromChat, status: 'cancelled' });
    expect(booked(client)).toEqual([]);
  });

  it('leaves alone a transcript that was never loaded, and bookings from no conversation', () => {
    const client = new QueryClient();
    upsertAppointmentInCaches(client, fromChat);
    upsertAppointmentInCaches(client, soon);
    expect(client.getQueryData(transcriptKey)).toBeUndefined();
  });
});
