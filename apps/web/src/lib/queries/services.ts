import { useQuery } from '@tanstack/react-query';
import { servicesApi } from '@/lib/api';
import { queryKeys } from './keys';

/** The business's bookable services. The catalogue rarely changes, so it is cached for minutes, not seconds. */
export function useServices() {
  return useQuery({
    queryKey: queryKeys.services.list(),
    queryFn: ({ signal }) => servicesApi.list(signal),
    staleTime: 5 * 60_000,
  });
}

/**
 * Free and taken slots for one service on one business-zone date. Disabled
 * until both inputs exist, so a form can call it before the user has chosen.
 *
 * Short staleTime: availability is the most contended data in the app (any
 * other customer can take a slot), so a slot grid older than a few seconds
 * should be revalidated when it is shown again.
 */
export function useAvailability(serviceId: string | null | undefined, date: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.availability.forDate(serviceId ?? '', date ?? ''),
    queryFn: ({ signal }) => servicesApi.availability(serviceId!, date!, signal),
    enabled: Boolean(serviceId && date),
    staleTime: 10_000,
  });
}
