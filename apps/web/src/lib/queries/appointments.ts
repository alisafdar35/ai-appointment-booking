import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { ERROR_CODES } from '@appt/shared';
import { appointmentsApi, hasErrorCode, type AppointmentFilters, type CreateAppointmentRequest } from '@/lib/api';
import { findCachedAppointment, placeAppointmentInCaches, upsertAppointmentInCaches } from './appointment-cache';
import { queryKeys } from './keys';

export function useAppointments(filters: AppointmentFilters = {}) {
  return useQuery({
    queryKey: queryKeys.appointments.list(filters),
    queryFn: ({ signal }) => appointmentsApi.list(filters, signal),
  });
}

/**
 * Book via the structured form. On success the appointment is merged into every
 * cache that can show it. On a slot conflict the availability grid is
 * refetched, so the picker immediately shows what is actually free now.
 */
/** What the booking form submits: the request body, plus the key naming this booking attempt. */
export type CreateAppointmentVariables = CreateAppointmentRequest & { idempotencyKey?: string };

export function useCreateAppointment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...input }: CreateAppointmentVariables) =>
      appointmentsApi.create(input, idempotencyKey ? { idempotencyKey } : undefined),
    onSuccess: (appointment) => upsertAppointmentInCaches(queryClient, appointment),
    onError: (error, input) => {
      if (hasErrorCode(error, ERROR_CODES.SLOT_UNAVAILABLE)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.availability.forService(input.serviceId) });
      }
    },
  });
}

type CacheSnapshot = [QueryKey, unknown][];

/**
 * Cancel with an optimistic update: the cancelled copy is placed exactly as the
 * server's answer will be — out of Upcoming, into Cancelled — and every cache
 * is rolled back if the server refuses (already past, not yours, network down).
 */
export function useCancelAppointment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => appointmentsApi.cancel(id, reason),
    onMutate: async ({ id, reason }) => {
      // An in-flight refetch would land after the optimistic write and overwrite it.
      await queryClient.cancelQueries({ queryKey: queryKeys.appointments.all });
      const snapshot: CacheSnapshot = queryClient.getQueriesData({ queryKey: queryKeys.appointments.all });
      const current = findCachedAppointment(queryClient, id);
      if (current) placeAppointmentInCaches(queryClient, { ...current, status: 'cancelled', cancellationReason: reason ?? null });
      return { snapshot };
    },
    onError: (_error, _input, context) => {
      context?.snapshot.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSuccess: (appointment) => upsertAppointmentInCaches(queryClient, appointment),
    // Whatever happened, reconcile with the server: the slot may now be free.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.appointments.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.availability.all });
    },
  });
}
