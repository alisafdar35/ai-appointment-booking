import { CalendarCheck, CalendarX2, History, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AppointmentDto } from '@appt/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { errorMessage } from '@/lib/api';
import { AppointmentCard } from './AppointmentCard';
import type { AppointmentView } from './lib/appointments';

const VIEW_LABELS: Record<AppointmentView, string> = {
  upcoming: 'Upcoming appointments',
  past: 'Past appointments',
  cancelled: 'Cancelled appointments',
};

interface QueryState {
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => unknown;
}

interface AppointmentListProps {
  view: AppointmentView;
  query: QueryState;
  /** The tab's appointments, already selected and ordered; undefined until the first load succeeds. */
  items: readonly AppointmentDto[] | undefined;
  timezone: string;
  now: Date;
  showCustomer: boolean;
  highlightedIds: ReadonlySet<string>;
  onCancel: (appointment: AppointmentDto) => void;
  onBook: () => void;
}

function ListSkeleton() {
  return (
    <div role="status" className="space-y-3">
      <span className="sr-only">Loading appointments</span>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex gap-4 rounded-xl border border-border bg-surface p-5 shadow-card">
          <Skeleton className="size-14 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-4 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function emptyState(view: AppointmentView, onBook: () => void): ReactNode {
  const bookButton = (
    <Button leftIcon={<Plus className="size-4" aria-hidden="true" />} onClick={onBook}>
      Book an appointment
    </Button>
  );
  switch (view) {
    case 'upcoming':
      return (
        <EmptyState
          icon={CalendarCheck}
          title="Nothing coming up"
          description="Book a time that suits you, or ask the assistant to find one."
          action={bookButton}
        />
      );
    case 'past':
      return (
        <EmptyState
          icon={History}
          title="No past appointments yet"
          description="Appointments you have already attended will be listed here."
        />
      );
    case 'cancelled':
      return (
        <EmptyState
          icon={CalendarX2}
          title="No cancelled appointments"
          description="If a plan changes, cancelled bookings stay here for your records."
        />
      );
  }
}

/** One tab's worth of appointments, with a deliberate loading, error and empty state each. */
export function AppointmentList({
  view,
  query,
  items,
  timezone,
  now,
  showCustomer,
  highlightedIds,
  onCancel,
  onBook,
}: AppointmentListProps) {
  if (!items) {
    if (query.isPending) return <ListSkeleton />;
    return (
      <Alert
        tone="error"
        title="We couldn't load your appointments"
        action={
          <Button size="sm" variant="secondary" loading={query.isFetching} onClick={() => query.refetch()}>
            Try again
          </Button>
        }
      >
        {errorMessage(query.error)}
      </Alert>
    );
  }

  if (items.length === 0) return emptyState(view, onBook);

  return (
    <ul aria-label={VIEW_LABELS[view]} className="space-y-3">
      {items.map((appointment) => (
        <li key={appointment.id}>
          <AppointmentCard
            appointment={appointment}
            timezone={timezone}
            now={now}
            showCustomer={showCustomer}
            highlighted={highlightedIds.has(appointment.id)}
            onCancel={onCancel}
          />
        </li>
      ))}
    </ul>
  );
}
