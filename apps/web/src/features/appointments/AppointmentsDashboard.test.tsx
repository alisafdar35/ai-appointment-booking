import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { listAppointmentsSchema, type AppointmentDto, type UserDto } from '@appt/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, appointmentsApi, servicesApi } from '@/lib/api';
import { AppointmentsDashboard } from './AppointmentsDashboard';
import { CHECKUP, PAST, makeAppointment, renderWithProviders } from './test-support';

const auth = vi.hoisted(() => ({ role: 'customer' as 'customer' | 'staff' }));

vi.mock('@/providers/AuthProvider', () => ({
  useBusinessTimezone: () => 'America/New_York',
  useCurrentUser: () => ({ id: 'u1', role: auth.role, businessName: 'Bluewave Dental' }) as UserDto,
}));

const upcoming = makeAppointment({ id: 'a0000000-0000-4000-8000-0000000000a1', notes: 'Bring my x-rays' });
const past = makeAppointment({ id: 'a0000000-0000-4000-8000-0000000000b1', ...PAST, source: 'chat' });
const cancelled = makeAppointment({
  id: 'a0000000-0000-4000-8000-0000000000c1',
  status: 'cancelled',
  startsAt: '2099-11-02T15:00:00.000Z',
  endsAt: '2099-11-02T15:30:00.000Z',
  cancellationReason: 'Travelling that week',
});

/**
 * A tiny in-memory stand-in for the API, so a mutation and the refetch after it
 * agree. It reads the query with the API's own schema and orders like the API.
 */
let server: AppointmentDto[];

function serve() {
  vi.spyOn(appointmentsApi, 'list').mockImplementation(async (query = {}) => {
    const { status, window, limit } = listAppointmentsSchema.parse(query);
    return server
      .filter((a) => {
        if (status && !status.includes(a.status)) return false;
        const isPast = new Date(a.startsAt) < new Date();
        return window === 'upcoming' ? !isPast : window === 'past' ? isPast : true;
      })
      .sort((a, b) => (window === 'upcoming' ? 1 : -1) * a.startsAt.localeCompare(b.startsAt))
      .slice(0, limit);
  });
  vi.spyOn(servicesApi, 'list').mockResolvedValue([CHECKUP]);
}

beforeEach(() => {
  auth.role = 'customer';
  server = [upcoming, past, cancelled];
  serve();
});
afterEach(() => vi.restoreAllMocks());

const tab = (name: RegExp) => screen.findByRole('tab', { name });

describe('AppointmentsDashboard list', () => {
  it('shows a loading state while the lists are in flight', () => {
    vi.spyOn(appointmentsApi, 'list').mockReturnValue(new Promise(() => {}));
    renderWithProviders(<AppointmentsDashboard />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading appointments');
  });

  it('offers a retry when the list cannot be loaded', async () => {
    const list = vi
      .spyOn(appointmentsApi, 'list')
      .mockRejectedValue(new ApiError({ status: 0, code: 'NETWORK', message: "Can't reach the server." }));
    renderWithProviders(<AppointmentsDashboard />);

    expect(await screen.findByText("Can't reach the server.")).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load your appointments");

    list.mockImplementation(async () => [upcoming]);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Routine Checkup' })).toBeInTheDocument();
  });

  it('stops showing the summary as loading once the lists have failed', async () => {
    vi.spyOn(appointmentsApi, 'list').mockRejectedValue(
      new ApiError({ status: 500, code: 'INTERNAL', message: 'The server had a problem.' }),
    );
    renderWithProviders(<AppointmentsDashboard />);

    await screen.findByText('The server had a problem.');
    const tiles = screen.getByLabelText('Appointment summary');
    expect(within(tiles).getAllByText('Unavailable')).toHaveLength(3);
  });

  it('renders each appointment as an article with its details in the business timezone', async () => {
    renderWithProviders(<AppointmentsDashboard />);

    const card = await screen.findByRole('article', { name: 'Routine Checkup' });
    expect(within(card).getByText('2:00 PM – 2:30 PM')).toBeInTheDocument();
    expect(within(card).getByText('30 min · $80')).toBeInTheDocument();
    expect(within(card).getByText('Confirmed')).toBeInTheDocument();
    expect(within(card).getByText('Form')).toBeInTheDocument();
    expect(within(card).getByText('Bring my x-rays')).toBeInTheDocument();
    expect(within(card).getByText(/^\(in .*\)$/)).toBeInTheDocument();
  });

  it('summarises the lists in the tiles and tab counts', async () => {
    renderWithProviders(<AppointmentsDashboard />);

    expect(await tab(/^Upcoming\s*1$/)).toBeInTheDocument();
    expect(await tab(/^Past\s*1$/)).toBeInTheDocument();
    expect(await tab(/^Cancelled\s*1$/)).toBeInTheDocument();

    const tiles = screen.getByLabelText('Appointment summary');
    expect(within(tiles).getByText(/^\w{3}, Oct 5 · 2:00 PM$/)).toBeInTheDocument();
    expect(within(tiles).getByText(/^Routine Checkup · in /)).toBeInTheDocument();
  });

  it('marks a count taken from a full page as a lower bound, in the tile as in the tab', async () => {
    server = Array.from({ length: 100 }, (_, index) =>
      makeAppointment({
        id: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        startsAt: `2099-11-02T${String(10 + (index % 8)).padStart(2, '0')}:00:00.000Z`,
        endsAt: `2099-11-02T${String(10 + (index % 8)).padStart(2, '0')}:30:00.000Z`,
      }),
    );
    renderWithProviders(<AppointmentsDashboard />);

    expect(await tab(/^Upcoming\s*100\+$/)).toBeInTheDocument();
    const upcomingTile = within(screen.getByLabelText('Appointment summary')).getByText('Upcoming').parentElement!;
    expect(upcomingTile).toHaveTextContent(/^Upcoming100\+$/);
  });

  it('keeps past and cancelled bookings off the upcoming tab, and out of reach of Cancel', async () => {
    renderWithProviders(<AppointmentsDashboard />);
    await screen.findByRole('article', { name: 'Routine Checkup' });
    expect(screen.getAllByRole('article')).toHaveLength(1);

    await userEvent.click(await tab(/^Past/));
    const pastCard = await screen.findByRole('article', { name: 'Routine Checkup' });
    expect(within(pastCard).getByText('Completed')).toBeInTheDocument();
    expect(within(pastCard).getByText('Chat')).toBeInTheDocument();
    expect(within(pastCard).queryByRole('button')).not.toBeInTheDocument();

    await userEvent.click(await tab(/^Cancelled/));
    const cancelledCard = await screen.findByRole('article', { name: 'Routine Checkup' });
    expect(within(cancelledCard).getByText('Cancelled')).toBeInTheDocument();
    expect(within(cancelledCard).getByText('Travelling that week')).toBeInTheDocument();
    expect(within(cancelledCard).queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a friendly empty state per tab, with a booking shortcut on Upcoming', async () => {
    server = [];
    renderWithProviders(<AppointmentsDashboard />);

    expect(await screen.findByText('Nothing coming up')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Book an appointment' }));
    expect(await screen.findByRole('dialog', { name: 'New appointment' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    await userEvent.click(await tab(/^Past/));
    expect(await screen.findByText('No past appointments yet')).toBeInTheDocument();
    await userEvent.click(await tab(/^Cancelled/));
    expect(await screen.findByText('No cancelled appointments')).toBeInTheDocument();
  });

  it('opens the booking dialog from the header and returns focus to the button on close', async () => {
    renderWithProviders(<AppointmentsDashboard />);
    const trigger = await screen.findByRole('button', { name: 'New appointment' });
    await userEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'New appointment' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('AppointmentsDashboard roles', () => {
  it('shows a customer only their own bookings, without a customer line', async () => {
    renderWithProviders(<AppointmentsDashboard />);
    const card = await screen.findByRole('article', { name: 'Routine Checkup' });
    expect(within(card).queryByText('Casey Customer')).not.toBeInTheDocument();
    expect(screen.getByText('Your upcoming and past bookings.')).toBeInTheDocument();
  });

  it('shows staff whose booking each one is', async () => {
    auth.role = 'staff';
    renderWithProviders(<AppointmentsDashboard />);

    const card = await screen.findByRole('article', { name: 'Routine Checkup' });
    expect(within(card).getByText('Casey Customer')).toBeInTheDocument();
    expect(within(card).getByText('casey@example.test')).toBeInTheDocument();
    expect(screen.getByText(/Every booking at Bluewave Dental/)).toBeInTheDocument();
    // The next-appointment tile names the customer too.
    expect(within(screen.getByLabelText('Appointment summary')).getByText(/Routine Checkup · Casey Customer · in /)).toBeInTheDocument();
  });
});

describe('cancelling an appointment', () => {
  const openCancelDialog = async () => {
    const button = await screen.findByRole('button', { name: /^Cancel Routine Checkup on \w{3}, Oct 5$/ });
    await userEvent.click(button);
    return screen.findByRole('dialog', { name: 'Cancel this appointment?' });
  };

  it('moves focus to the safe choice and sends the reason on confirm', async () => {
    const cancel = vi.spyOn(appointmentsApi, 'cancel').mockImplementation(async (id, reason) => {
      const done = { ...upcoming, status: 'cancelled' as const, cancellationReason: reason ?? null };
      server = server.map((a) => (a.id === id ? done : a));
      return done;
    });
    renderWithProviders(<AppointmentsDashboard />);

    const dialog = await openCancelDialog();
    expect(within(dialog).getByRole('button', { name: 'Keep appointment' })).toHaveFocus();

    await userEvent.type(within(dialog).getByLabelText('Reason (optional)'), 'Change of plans');
    expect(within(dialog).getByText('15/500')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith(upcoming.id, 'Change of plans'));
    expect(await screen.findByText('Appointment cancelled')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Nothing coming up')).toBeInTheDocument();
    expect(await tab(/^Cancelled\s*2$/)).toBeInTheDocument();
  });

  it('sends no reason when the field is left empty', async () => {
    const cancel = vi.spyOn(appointmentsApi, 'cancel').mockResolvedValue({ ...upcoming, status: 'cancelled' });
    renderWithProviders(<AppointmentsDashboard />);

    const dialog = await openCancelDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith(upcoming.id, undefined));
  });

  it('refuses a reason over 500 characters before calling the API', async () => {
    const cancel = vi.spyOn(appointmentsApi, 'cancel');
    renderWithProviders(<AppointmentsDashboard />);

    const dialog = await openCancelDialog();
    await userEvent.click(within(dialog).getByLabelText('Reason (optional)'));
    await userEvent.paste('x'.repeat(501));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Keep the reason to 500 characters or fewer.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }));

    expect(cancel).not.toHaveBeenCalled();
  });

  it('updates the list at once, then rolls back and says so when the server refuses', async () => {
    let refuse: (error: ApiError) => void = () => {};
    vi.spyOn(appointmentsApi, 'cancel').mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    renderWithProviders(<AppointmentsDashboard />);

    const dialog = await openCancelDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }));

    // Optimistic: the booking has already left the Upcoming list, and the confirm button is busy.
    await waitFor(() => expect(screen.getByText('Nothing coming up')).toBeInTheDocument());
    expect(within(dialog).getByRole('button', { name: 'Cancel appointment' })).toHaveAttribute('aria-busy', 'true');

    refuse(new ApiError({ status: 500, code: 'INTERNAL', message: 'The server had a problem.' }));

    expect(await screen.findByText('The server had a problem.')).toBeInTheDocument();
    expect(screen.getByText("Couldn't cancel the appointment")).toBeInTheDocument();
    // Rolled back: the appointment is back, and the dialog stays open so the user can retry.
    expect(await screen.findByRole('article', { name: 'Routine Checkup' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Cancel this appointment?' })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel appointment' })).toBeEnabled();
  });

  it('closes and says so when the appointment was already cancelled elsewhere, then shows where it stands', async () => {
    vi.spyOn(appointmentsApi, 'cancel').mockImplementation(async (id) => {
      // Another tab got there first.
      server = server.map((a) => (a.id === id ? { ...a, status: 'cancelled' as const } : a));
      throw new ApiError({ status: 409, code: 'APPOINTMENT_NOT_CANCELLABLE', message: 'This appointment is already cancelled.' });
    });
    renderWithProviders(<AppointmentsDashboard />);

    const dialog = await openCancelDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }));

    expect(await screen.findByText('Already taken care of')).toBeInTheDocument();
    expect(screen.getByText('This appointment is already cancelled. There was nothing left to cancel.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText("Couldn't cancel the appointment")).not.toBeInTheDocument();
    expect(await tab(/^Cancelled\s*2$/)).toBeInTheDocument();
    expect(await screen.findByText('Nothing coming up')).toBeInTheDocument();
  });

  it('closes without cancelling when the user keeps the appointment', async () => {
    const cancel = vi.spyOn(appointmentsApi, 'cancel');
    renderWithProviders(<AppointmentsDashboard />);

    const dialog = await openCancelDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep appointment' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole('article', { name: 'Routine Checkup' })).toBeInTheDocument();
  });
});
