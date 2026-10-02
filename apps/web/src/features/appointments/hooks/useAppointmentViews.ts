import { useAppointments } from '@/lib/queries';
import { VIEW_FILTERS } from '../lib/appointments';

/**
 * The three dashboard lists with their queries, ready to render, plus the next
 * appointment. Each list arrives filtered and ordered (soonest first) by the
 * API, so `items[view]` is simply that query's data: undefined until loaded.
 * `nextFailed` says the upcoming list failed, so the summary stops loading.
 */
export function useAppointmentViews() {
  const upcoming = useAppointments(VIEW_FILTERS.upcoming);
  const past = useAppointments(VIEW_FILTERS.past);
  const cancelled = useAppointments(VIEW_FILTERS.cancelled);

  const items = { upcoming: upcoming.data, past: past.data, cancelled: cancelled.data };
  const next = upcoming.data ? (upcoming.data[0] ?? null) : undefined;
  const nextFailed = next === undefined && upcoming.isError;

  return { queries: { upcoming, past, cancelled }, items, next, nextFailed };
}
