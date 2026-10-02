import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AppointmentDto, AvailabilityDto, UserDto } from '@appt/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { ApiError, apiRequest, appointmentsApi, servicesApi } from '@/lib/api';
import { queryKeys } from '@/lib/queries';
import { BookingDialog } from './BookingDialog';
import { CHECKUP, WHITENING, makeAppointment, renderWithProviders } from './test-support';

const SAVED_DRAFT_KEY = 'slotly.interrupted.booking-dialog';

vi.mock('@/providers/AuthProvider', () => ({
  useBusinessTimezone: () => 'America/New_York',
  useCurrentUser: () => ({ id: 'u1', role: 'customer', businessName: 'Bluewave Dental' }) as UserDto,
}));

const DATE = '2099-10-05'; // a Monday, in the far future so "today or later" always holds

const grid = (serviceId: string): AvailabilityDto => ({
  date: DATE,
  serviceId,
  durationMinutes: serviceId === CHECKUP.id ? 30 : 60,
  closed: false,
  slots: [
    { time: '09:00', available: true },
    { time: '09:30', available: false },
    { time: '14:00', available: true },
  ],
});

let onOpenChange: Mock<(open: boolean) => void>;
let onBooked: Mock<(appointment: AppointmentDto) => void>;
let availability: MockInstance<typeof servicesApi.availability>;

beforeEach(() => {
  onOpenChange = vi.fn();
  onBooked = vi.fn();
  vi.spyOn(servicesApi, 'list').mockResolvedValue([CHECKUP, WHITENING]);
  availability = vi.spyOn(servicesApi, 'availability').mockImplementation(async (serviceId) => grid(serviceId));
});
afterEach(() => vi.restoreAllMocks());

const open = () =>
  renderWithProviders(<BookingDialog open onOpenChange={onOpenChange} onBooked={onBooked} />);

const submit = () => userEvent.click(screen.getByRole('button', { name: 'Book appointment' }));
const chooseService = async (name: RegExp) => userEvent.click(await screen.findByRole('radio', { name }));
const chooseDate = (value: string) => fireEvent.change(screen.getByLabelText(/^Date/), { target: { value } });
const chooseTime = async (label: string) => userEvent.click(await screen.findByRole('radio', { name: label }));

async function fillBooking() {
  await chooseService(/Routine Checkup/);
  chooseDate(DATE);
  await chooseTime('2:00 PM');
}

describe('BookingDialog', () => {
  it('is a dialog named "New appointment" that focuses its first field', async () => {
    // The dashboard keeps the dialog mounted while closed, which warms the services
    // cache; opening it afterwards is what a user does, so the options are ready to focus.
    const { rerender, client } = renderWithProviders(<BookingDialog open={false} onOpenChange={vi.fn()} onBooked={vi.fn()} />);
    await waitFor(() => expect(client.getQueryData(queryKeys.services.list())).toBeDefined());

    rerender(<BookingDialog open onOpenChange={vi.fn()} onBooked={vi.fn()} />);
    expect(await screen.findByRole('dialog', { name: 'New appointment' })).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: /Routine Checkup/ })).toHaveFocus();
  });

  it('shows each service with its duration and price as a radio choice', async () => {
    open();
    const group = await screen.findByRole('radiogroup', { name: 'Service' });
    expect(within(group).getByRole('radio', { name: /Routine Checkup.*\$80.*30 min.*thorough exam/s })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: /Teeth Whitening.*\$150\.50.*60 min/s })).toBeInTheDocument();
  });

  it('asks for the time only once a service and date are chosen', async () => {
    open();
    expect(await screen.findByText(/choose a service and a date/i)).toBeInTheDocument();
    await chooseService(/Routine Checkup/);
    chooseDate(DATE);
    expect(await screen.findByRole('radiogroup', { name: 'Available times' })).toBeInTheDocument();
    expect(availability).toHaveBeenCalledWith(CHECKUP.id, DATE, expect.anything());
  });

  it('explains what is missing instead of calling the API', async () => {
    const create = vi.spyOn(appointmentsApi, 'create');
    open();
    await screen.findByRole('radio', { name: /Routine Checkup/ });
    await submit();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toEqual(['Choose a service', 'Choose a date', 'Choose a time']);
    expect(create).not.toHaveBeenCalled();
  });

  it('fills in a live summary in the business timezone', async () => {
    open();
    await fillBooking();

    const summary = screen.getByRole('region', { name: 'Booking summary' });
    expect(within(summary).getByText('Routine Checkup')).toBeInTheDocument();
    expect(within(summary).getByText(/^\w{3}, Oct 5 · 2:00 PM – 2:30 PM$/)).toBeInTheDocument();
    expect(within(summary).getByText('EDT (America/New_York)')).toBeInTheDocument();
    expect(within(summary).getByText('$80')).toBeInTheDocument();
  });

  it('forgets the chosen time when the service or the date changes', async () => {
    open();
    await fillBooking();
    expect(screen.getByRole('radio', { name: '2:00 PM' })).toBeChecked();

    await chooseService(/Teeth Whitening/);
    expect(await screen.findByRole('radio', { name: '2:00 PM' })).not.toBeChecked();
    await chooseTime('2:00 PM');

    chooseDate('2099-10-06');
    await waitFor(() => expect(screen.getByRole('radio', { name: '2:00 PM' })).not.toBeChecked());
    expect(within(screen.getByRole('region', { name: 'Booking summary' })).getAllByText('Not chosen yet').length).toBeGreaterThan(0);
  });

  it('books with the API\'s own payload, then toasts, closes and reports the appointment', async () => {
    const booked = makeAppointment();
    const create = vi.spyOn(appointmentsApi, 'create').mockResolvedValue(booked);
    open();
    await fillBooking();
    await userEvent.type(screen.getByLabelText('Notes (optional)'), '  Bring my x-rays ');
    await submit();

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      { serviceId: CHECKUP.id, date: DATE, time: '14:00', notes: 'Bring my x-rays', source: 'form' },
      { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    );
    expect(await screen.findByText('Routine Checkup booked')).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onBooked).toHaveBeenCalledWith(booked);
  });

  it('omits empty notes rather than sending a blank string', async () => {
    const create = vi.spyOn(appointmentsApi, 'create').mockResolvedValue(makeAppointment());
    open();
    await fillBooking();
    await submit();

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[0]).toMatchObject({ notes: undefined });
  });

  it('makes one request from two back-to-back clicks', async () => {
    const create = vi.spyOn(appointmentsApi, 'create').mockReturnValue(new Promise(() => {}));
    open();
    await fillBooking();

    const button = screen.getByRole('button', { name: 'Book appointment' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(create).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('the in-flight guard alone: two submits in one act, with no re-render between them, make one request', async () => {
    const create = vi.spyOn(appointmentsApi, 'create').mockReturnValue(new Promise(() => {}));
    open();
    await fillBooking();

    const button = screen.getByRole('button', { name: 'Book appointment' });
    const form = document.getElementById(button.getAttribute('form')!) as HTMLFormElement;
    // Submit events go straight to the form, so whether the button is disabled
    // plays no part; inside one act React cannot re-render between them.
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(create).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('the busy button alone: once a booking is in flight, clicking it again does not even submit the form', async () => {
    const create = vi.spyOn(appointmentsApi, 'create').mockReturnValue(new Promise(() => {}));
    open();
    await fillBooking();
    await submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    const button = screen.getByRole('button', { name: 'Book appointment' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    const form = document.getElementById(button.getAttribute('form')!) as HTMLFormElement;
    const submits = vi.fn();
    form.addEventListener('submit', submits);
    fireEvent.click(button);
    await userEvent.click(button, { pointerEventsCheck: 0 });
    expect(submits).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('names each booking attempt with an idempotency key, reused when the same booking is retried', async () => {
    const create = vi
      .spyOn(appointmentsApi, 'create')
      .mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK', message: "Can't reach the server." }))
      .mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK', message: "Can't reach the server." }))
      .mockResolvedValue(makeAppointment());
    open();
    await fillBooking();

    await submit();
    await screen.findByText("Can't reach the server.");
    await submit(); // Retry: the same booking
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await userEvent.type(screen.getByLabelText('Notes (optional)'), 'Changed my mind');
    await submit(); // A different booking now

    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    const keys = create.mock.calls.map(([, options]) => options?.idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  describe('when the session ends while the form is open', () => {
    afterEach(() => window.sessionStorage.clear());

    it('keeps what was entered, for this user, so signing in again brings it back', async () => {
      vi.spyOn(appointmentsApi, 'create').mockImplementation(() =>
        apiRequest('/appointments', { method: 'POST', body: {} }),
      );
      // Access token expired, and the refresh is refused: the session is over.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }), { status: 401 }),
        ),
      );
      open();
      await fillBooking();
      await userEvent.type(screen.getByLabelText('Notes (optional)'), 'Lower left molar');
      await submit();

      await waitFor(() => expect(window.sessionStorage.getItem(SAVED_DRAFT_KEY)).not.toBeNull());
      const saved = JSON.parse(window.sessionStorage.getItem(SAVED_DRAFT_KEY)!);
      expect(saved).toMatchObject({
        userId: 'u1',
        values: { serviceId: CHECKUP.id, date: DATE, time: '14:00', notes: 'Lower left molar' },
      });
      vi.unstubAllGlobals();
    });

    it('starts from the kept values, and says why', async () => {
      renderWithProviders(
        <BookingDialog
          open
          onOpenChange={onOpenChange}
          onBooked={onBooked}
          restored={{ serviceId: CHECKUP.id, date: DATE, time: '14:00', notes: 'Lower left molar', source: 'form' }}
        />,
      );
      expect(await screen.findByText('We kept your details')).toBeInTheDocument();
      expect(await screen.findByRole('radio', { name: /Routine Checkup/ })).toBeChecked();
      expect(screen.getByLabelText(/^Date/)).toHaveValue(DATE);
      expect(await screen.findByRole('radio', { name: '2:00 PM' })).toBeChecked();
      expect(screen.getByLabelText('Notes (optional)')).toHaveValue('Lower left molar');
    });
  });

  it('on a taken slot: says so, clears the time and refetches the grid', async () => {
    vi.spyOn(appointmentsApi, 'create').mockRejectedValue(
      new ApiError({ status: 409, code: 'SLOT_UNAVAILABLE', message: 'Slot unavailable' }),
    );
    open();
    await fillBooking();
    expect(availability).toHaveBeenCalledTimes(1);
    await submit();

    expect(await screen.findByText('That time was just taken. Pick another from the times above.')).toBeInTheDocument();
    await waitFor(() => expect(availability).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('radio', { name: '2:00 PM' })).not.toBeChecked());
    // The dialog stays open so the user can pick again.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New appointment' })).toBeInTheDocument();
  });

  it('clears that message as soon as another time is chosen', async () => {
    vi.spyOn(appointmentsApi, 'create').mockRejectedValue(
      new ApiError({ status: 409, code: 'SLOT_UNAVAILABLE', message: 'Slot unavailable' }),
    );
    open();
    await fillBooking();
    await submit();
    await screen.findByText('That time was just taken. Pick another from the times above.');

    await chooseTime('9:00 AM');
    expect(screen.queryByText('That time was just taken. Pick another from the times above.')).not.toBeInTheDocument();
  });

  it.each([
    ['OUTSIDE_BUSINESS_HOURS', 'We are closed at that time.'],
    ['APPOINTMENT_IN_PAST', 'That time has already passed.'],
  ] as const)('shows a %s failure on the time field', async (code, message) => {
    vi.spyOn(appointmentsApi, 'create').mockRejectedValue(new ApiError({ status: 422, code, message }));
    open();
    await fillBooking();
    await submit();

    const alert = await screen.findByText(message);
    expect(alert.closest('[role="alert"]')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '2:00 PM' })).toBeChecked();
  });

  it('maps server validation details onto their fields', async () => {
    vi.spyOn(appointmentsApi, 'create').mockRejectedValue(
      new ApiError({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'Invalid request',
        details: { notes: ['Notes contain unsupported characters'] },
      }),
    );
    open();
    await fillBooking();
    await submit();

    expect(await screen.findByText('Notes contain unsupported characters')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes (optional)')).toHaveAttribute('aria-invalid', 'true');
  });

  it.each([
    ['RATE_LIMITED', 429, 'Too many requests. Wait a moment and try again.'],
    ['NETWORK', 0, "Can't reach the server."],
  ] as const)('reports %s at the top of the form', async (code, status, expected) => {
    vi.spyOn(appointmentsApi, 'create').mockRejectedValue(
      new ApiError({ status, code, message: "Can't reach the server." }),
    );
    open();
    await fillBooking();
    await submit();

    const alert = await screen.findByText(expected);
    expect(alert.closest('[role="alert"]')).toHaveTextContent("We couldn't book that appointment");
  });

  it('puts a time the clocks skip (DST) on the time field, keeping the rest of the form', async () => {
    vi.spyOn(appointmentsApi, 'create').mockRejectedValue(
      new ApiError({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'Invalid request',
        details: { time: ['2:00 AM does not exist on that day: the clocks go forward.'] },
      }),
    );
    open();
    await fillBooking();
    await submit();

    const message = await screen.findByText('2:00 AM does not exist on that day: the clocks go forward.');
    expect(message.closest('[role="alert"]')).toBeInTheDocument();
    expect(screen.queryByText("We couldn't book that appointment")).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Routine Checkup/ })).toBeChecked();
  });

  it('offers a retry when the services cannot be loaded', async () => {
    const list = vi
      .spyOn(servicesApi, 'list')
      .mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL', message: 'The server had a problem.' }));
    open();

    expect(await screen.findByText('The server had a problem.')).toBeInTheDocument();
    list.mockResolvedValue([CHECKUP]);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('radio', { name: /Routine Checkup/ })).toBeInTheDocument();
  });

  it('closes from the Cancel button without booking', async () => {
    const create = vi.spyOn(appointmentsApi, 'create');
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(create).not.toHaveBeenCalled();
  });
});
