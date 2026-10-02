'use client';

import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppointmentDto } from '@appt/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/Tabs';
import { discardInterruptedDraft, readInterruptedDraft } from '@/lib/interrupted-drafts';
import { useBusinessTimezone, useCurrentUser } from '@/providers/AuthProvider';
import { AppointmentList } from './AppointmentList';
import { BOOKING_DRAFT_NAME, BookingDialog } from './BookingDialog';
import { CancelDialog } from './CancelDialog';
import { SummaryTiles } from './SummaryTiles';
import { useAppointmentViews } from './hooks/useAppointmentViews';
import { useChangeHighlights } from './hooks/useChangeHighlights';
import { useNow } from './hooks/useNow';
import {
  APPOINTMENT_VIEWS,
  formatCount,
  type AppointmentView,
} from './lib/appointments';
import type { BookingFormValues } from './lib/booking';

const VIEW_TITLES: Record<AppointmentView, string> = { upcoming: 'Upcoming', past: 'Past', cancelled: 'Cancelled' };

function isAppointmentView(value: string): value is AppointmentView {
  return (APPOINTMENT_VIEWS as readonly string[]).includes(value);
}

/**
 * The appointments workspace: summary, the three views, and the two dialogs
 * (book, cancel).
 *
 * All three views are fetched up front. They are small, indexed queries, and
 * it buys instant tab switches, a count on every tab and the summary tiles
 * from the same data, with no extra "stats" endpoint. The realtime provider
 * and the mutations keep every one of those caches current, and nothing here
 * waits on the socket: without it the list still refreshes on focus and after
 * every action this page performs.
 */
export function AppointmentsDashboard() {
  const user = useCurrentUser();
  const timezone = useBusinessTimezone();
  const now = useNow();
  const showCustomer = user.role !== 'customer';

  const [view, setView] = useState<AppointmentView>('upcoming');
  // A booking the session ended in the middle of comes back, open, after signing in again.
  const [restoredBooking, setRestoredBooking] = useState(() =>
    readInterruptedDraft<BookingFormValues>(BOOKING_DRAFT_NAME, user.id),
  );
  const [bookingOpen, setBookingOpen] = useState(() => restoredBooking !== null);
  useEffect(() => discardInterruptedDraft(BOOKING_DRAFT_NAME), []);

  const onBookingOpenChange = (open: boolean) => {
    setBookingOpen(open);
    // Restored once: the next "New appointment" starts blank.
    if (!open) setRestoredBooking(null);
  };
  const [cancelTarget, setCancelTarget] = useState<AppointmentDto | null>(null);
  const panelsRef = useRef<HTMLDivElement>(null);

  const { queries, items, summary, summaryFailed } = useAppointmentViews();
  const { highlightedIds, highlight } = useChangeHighlights(items[view], view);

  const onBooked = (appointment: AppointmentDto) => {
    // A new booking is always upcoming; show it there, wherever the user was.
    setView('upcoming');
    highlight([appointment.id]);
  };

  const onCancelled = () => {
    setCancelTarget(null);
    // The card that opened the dialog has left the list, so focus would fall
    // to <body>. Land on the list instead of losing the keyboard user's place.
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      panelsRef.current?.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')?.focus();
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Appointments"
        description={
          showCustomer
            ? `Every booking at ${user.businessName}, with the customer it belongs to.`
            : 'Your upcoming and past bookings.'
        }
        actions={
          <Button leftIcon={<Plus className="size-4" aria-hidden="true" />} onClick={() => setBookingOpen(true)}>
            New appointment
          </Button>
        }
      />

      <SummaryTiles summary={summary} failed={summaryFailed} timezone={timezone} now={now} showCustomer={showCustomer} />

      <div ref={panelsRef}>
        <Tabs value={view} onValueChange={(next) => isAppointmentView(next) && setView(next)}>
          <TabList label="Appointment views" className="max-sm:flex max-sm:w-full">
            {APPOINTMENT_VIEWS.map((value) => {
              const list = items[value];
              return (
                <Tab key={value} value={value} className="justify-center max-sm:flex-1 max-sm:px-2">
                  {VIEW_TITLES[value]}
                  {list ? (
                    <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                      {formatCount(list.length)}
                    </span>
                  ) : null}
                </Tab>
              );
            })}
          </TabList>
          {APPOINTMENT_VIEWS.map((value) => (
            <TabPanel key={value} value={value} className="mt-5">
              <AppointmentList
                view={value}
                query={queries[value]}
                items={items[value]}
                timezone={timezone}
                now={now}
                showCustomer={showCustomer}
                highlightedIds={highlightedIds}
                onCancel={setCancelTarget}
                onBook={() => setBookingOpen(true)}
              />
            </TabPanel>
          ))}
        </Tabs>
      </div>

      <BookingDialog
        open={bookingOpen}
        onOpenChange={onBookingOpenChange}
        onBooked={onBooked}
        restored={restoredBooking}
      />
      <CancelDialog
        appointment={cancelTarget}
        onOpenChange={(open) => !open && setCancelTarget(null)}
        onCancelled={onCancelled}
      />
    </div>
  );
}
