import type { AppointmentDto, CreateAppointmentInput } from '@appt/shared';
import { zonedTimeToUtc } from './zonedTime.js';
import type { ApiClient, ApiResponse } from './apiClient.js';
import { SEED } from './fixtures.js';

type BookingRequest = Partial<Omit<CreateAppointmentInput, 'source'>> & {
  date: string;
  time: string;
  source?: string;
};

/** POST /api/appointments for Routine Checkup unless the request says otherwise. */
export function book(
  client: ApiClient,
  request: BookingRequest,
): Promise<ApiResponse<{ appointment: AppointmentDto }>> {
  return client.post('/api/appointments', { serviceId: SEED.services.routineCheckup.id, ...request });
}

/** The UTC instant a business-local wall-clock time denotes, as the API serialises it. */
export const instant = (date: string, time: string, timeZone: string = SEED.bluewave.timezone): string =>
  zonedTimeToUtc(date, time, timeZone).toISOString();
