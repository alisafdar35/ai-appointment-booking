import type { AvailabilityDto, ServiceDto } from '@appt/shared';
import { apiRequest } from './client';

export const servicesApi = {
  /** The bookable catalogue for the signed-in user's business. */
  list: async (signal?: AbortSignal): Promise<ServiceDto[]> =>
    (await apiRequest<{ services: ServiceDto[] }>('/services', { signal })).services,

  /** Slot times are 24h "HH:MM" in the business timezone; `date` is "YYYY-MM-DD" in the same zone. */
  availability: async (serviceId: string, date: string, signal?: AbortSignal): Promise<AvailabilityDto> =>
    (
      await apiRequest<{ availability: AvailabilityDto }>(
        `/services/${encodeURIComponent(serviceId)}/availability`,
        { query: { date }, signal },
      )
    ).availability,
};
