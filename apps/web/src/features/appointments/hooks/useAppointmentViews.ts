import { useMemo } from 'react';
import { useAppointments } from '@/lib/queries';
import { VIEW_FILTERS, summarize } from '../lib/appointments';

/**
 * The three dashboard lists with their queries, ready to render, plus the
 * summary derived from them. Each list arrives filtered and ordered by the
 * API, so `items[view]` is simply that query's data: undefined until it has
 * loaded. The summary stays null until the lists it counts have, and
 * `summaryFailed` says when one of them has failed instead, so the tiles can
 * stop showing a load that is no longer happening.
 */
export function useAppointmentViews() {
  const upcoming = useAppointments(VIEW_FILTERS.upcoming);
  const past = useAppointments(VIEW_FILTERS.past);
  const cancelled = useAppointments(VIEW_FILTERS.cancelled);

  const items = { upcoming: upcoming.data, past: past.data, cancelled: cancelled.data };
  const summary = useMemo(
    () => (upcoming.data && cancelled.data ? summarize(upcoming.data, cancelled.data) : null),
    [upcoming.data, cancelled.data],
  );

  const summaryFailed = summary === null && (upcoming.isError || cancelled.isError);

  return { queries: { upcoming, past, cancelled }, items, summary, summaryFailed };
}
