import type { z } from 'zod';
import {
  IDEMPOTENCY_KEY_HEADER,
  type AppointmentDto,
  type AppointmentStatus,
  type createAppointmentSchema,
  type listAppointmentsSchema,
} from '@appt/shared';
import { apiRequest } from './client';

/** Request shapes use the schemas' *input* types: defaults such as `source` are applied server-side. */
export type CreateAppointmentRequest = z.input<typeof createAppointmentSchema>;
export type AppointmentFilters = z.input<typeof listAppointmentsSchema>;

/** The list endpoint takes several statuses as one comma-separated value: `status=pending,confirmed`. */
export const statusFilter = (statuses: readonly AppointmentStatus[]): string => statuses.join(',');

export const appointmentsApi = {
  /**
   * Soonest first for the upcoming window, newest first otherwise. Customers see
   * their own bookings; staff and owners see the whole business.
   */
  list: async (filters: AppointmentFilters = {}, signal?: AbortSignal): Promise<AppointmentDto[]> =>
    (await apiRequest<{ appointments: AppointmentDto[] }>('/appointments', { query: filters, signal })).appointments,

  /**
   * 409 SLOT_UNAVAILABLE if taken, 422 OUTSIDE_BUSINESS_HOURS / APPOINTMENT_IN_PAST.
   *
   * `idempotencyKey` names one booking attempt. Sending the same attempt again
   * (a retry after a dropped connection, say) reuses the key, so a server that
   * honours `Idempotency-Key` answers with the booking it already made instead
   * of making a second one. A server that ignores the header loses nothing.
   */
  create: async (input: CreateAppointmentRequest, options: { idempotencyKey?: string } = {}): Promise<AppointmentDto> =>
    (
      await apiRequest<{ appointment: AppointmentDto }>('/appointments', {
        method: 'POST',
        body: input,
        headers: options.idempotencyKey ? { [IDEMPOTENCY_KEY_HEADER]: options.idempotencyKey } : undefined,
      })
    ).appointment,

  /** 409 APPOINTMENT_NOT_CANCELLABLE when it is already cancelled or completed. */
  cancel: async (id: string, reason?: string): Promise<AppointmentDto> =>
    (
      await apiRequest<{ appointment: AppointmentDto }>(`/appointments/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: { reason },
      })
    ).appointment,
};
