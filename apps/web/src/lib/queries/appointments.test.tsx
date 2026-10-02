import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AppointmentDto } from '@appt/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, appointmentsApi } from '@/lib/api';
import { useCancelAppointment } from './appointments';
import { queryKeys } from './keys';

const confirmed: AppointmentDto = {
  id: 'a1',
  status: 'confirmed',
  source: 'form',
  startsAt: '2099-10-06T15:00:00.000Z',
  endsAt: '2099-10-06T15:30:00.000Z',
  notes: null,
  cancellationReason: null,
  chatSessionId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  service: { id: 'svc', name: 'Cleaning', description: null, durationMinutes: 30, priceCents: 9000 },
  customer: { id: 'u1', fullName: 'Casey Customer', email: 'casey@example.test' },
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.appointments.list({}), [confirmed]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useCancelAppointment(), { wrapper });
  const list = () => client.getQueryData<AppointmentDto[]>(queryKeys.appointments.list({}));
  return { client, result, list };
}

afterEach(() => vi.restoreAllMocks());

describe('useCancelAppointment', () => {
  it('flips the appointment to cancelled immediately, before the server answers', async () => {
    vi.spyOn(appointmentsApi, 'cancel').mockReturnValue(new Promise(() => {}));
    const { result, list } = setup();

    act(() => result.current.mutate({ id: 'a1', reason: 'Change of plans' }));

    await waitFor(() => expect(list()?.[0]?.status).toBe('cancelled'));
    expect(list()?.[0]?.cancellationReason).toBe('Change of plans');
  });

  it('moves it from an active-only list to the cancelled list at once, as the server will', async () => {
    vi.spyOn(appointmentsApi, 'cancel').mockReturnValue(new Promise(() => {}));
    const { client, result } = setup();
    const active = { window: 'upcoming', status: 'pending,confirmed' } as const;
    client.setQueryData(queryKeys.appointments.list(active), [confirmed]);
    client.setQueryData(queryKeys.appointments.list({ status: 'cancelled' }), []);

    act(() => result.current.mutate({ id: 'a1' }));

    await waitFor(() => expect(client.getQueryData(queryKeys.appointments.list(active))).toEqual([]));
    expect(client.getQueryData<AppointmentDto[]>(queryKeys.appointments.list({ status: 'cancelled' }))?.[0]?.id).toBe('a1');
  });

  it('keeps the server-confirmed appointment on success', async () => {
    const cancelled = { ...confirmed, status: 'cancelled' as const, cancellationReason: 'Change of plans' };
    vi.spyOn(appointmentsApi, 'cancel').mockResolvedValue(cancelled);
    const { result, list } = setup();

    await act(() => result.current.mutateAsync({ id: 'a1', reason: 'Change of plans' }));

    expect(list()).toEqual([cancelled]);
  });

  it('rolls every cache back when the server refuses', async () => {
    vi.spyOn(appointmentsApi, 'cancel').mockRejectedValue(
      new ApiError({ status: 422, code: 'APPOINTMENT_IN_PAST', message: 'That time is in the past' }),
    );
    const { result, list } = setup();

    await act(async () => {
      await result.current.mutateAsync({ id: 'a1' }).catch(() => undefined);
    });

    expect(list()).toEqual([confirmed]);
    await waitFor(() => expect(result.current.error).toMatchObject({ code: 'APPOINTMENT_IN_PAST' }));
  });

  it('refreshes availability for the freed slot once settled', async () => {
    vi.spyOn(appointmentsApi, 'cancel').mockResolvedValue({ ...confirmed, status: 'cancelled' });
    const { client, result } = setup();
    client.setQueryData(queryKeys.availability.forDate('svc', '2099-10-06'), { slots: [] });

    await act(() => result.current.mutateAsync({ id: 'a1' }));

    expect(client.getQueryState(queryKeys.availability.forDate('svc', '2099-10-06'))?.isInvalidated).toBe(true);
  });
});
