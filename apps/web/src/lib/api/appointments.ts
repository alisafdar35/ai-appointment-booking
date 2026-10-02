import type { z } from 'zod';
import type { AppointmentDto, AppointmentStatus, createAppointmentSchema, listAppointmentsSchema } from '@appt/shared';
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

  /** 409 SLOT_UNAVAILABLE if taken, 422 OUTSIDE_BUSINESS_HOURS / APPOINTMENT_IN_PAST. */
  create: async (input: CreateAppointmentRequest): Promise<AppointmentDto> =>
    (await apiRequest<{ appointment: AppointmentDto }>('/appointments', { method: 'POST', body: input })).appointment,

  /** 409 APPOINTMENT_NOT_CANCELLABLE when it is already cancelled or completed. */
  cancel: async (id: string, reason?: string): Promise<AppointmentDto> =>
    (
      await apiRequest<{ appointment: AppointmentDto }>(`/appointments/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: { reason },
      })
    ).appointment,
};
