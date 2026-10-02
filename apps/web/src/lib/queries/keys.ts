import type { AppointmentFilters } from '@/lib/api';

/**
 * Query keys, built hierarchically so invalidation can be as broad or as narrow
 * as needed: invalidating `appointments.all` refreshes every list and detail,
 * `appointments.lists()` only the lists, `availability.forService(id)` every
 * date for one service. Keys live here, in one place, so a typo cannot create
 * a cache entry nothing ever invalidates.
 */
export const queryKeys = {
  services: {
    all: ['services'] as const,
    list: () => [...queryKeys.services.all, 'list'] as const,
  },
  availability: {
    all: ['availability'] as const,
    forService: (serviceId: string) => [...queryKeys.availability.all, serviceId] as const,
    forDate: (serviceId: string, date: string) => [...queryKeys.availability.forService(serviceId), date] as const,
  },
  appointments: {
    all: ['appointments'] as const,
    lists: () => [...queryKeys.appointments.all, 'list'] as const,
    list: (filters: AppointmentFilters = {}) => [...queryKeys.appointments.lists(), filters] as const,
  },
  chat: {
    all: ['chat'] as const,
    sessions: () => [...queryKeys.chat.all, 'sessions'] as const,
    transcript: (sessionId: string) => [...queryKeys.chat.all, 'transcript', sessionId] as const,
  },
} as const;

/** The shape of a key produced by `queryKeys.appointments.list`, for reading filters back out of the cache. */
export type AppointmentListKey = ReturnType<typeof queryKeys.appointments.list>;
