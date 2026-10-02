import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_SLOTS, type AssistantTurnDto, type AvailabilityDto, type BookingSlots } from '@appt/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, servicesApi } from '@/lib/api';
import { CHECKUP, COMPLETE_DRAFT, WHITENING, appointment, turn } from '../test/factories';
import { FallbackFormCard } from './FallbackFormCard';

vi.mock('@/providers/AuthProvider', () => ({ useBusinessTimezone: () => 'America/New_York' }));

const DAY: AvailabilityDto = {
  date: '2026-10-05',
  serviceId: CHECKUP.id,
  durationMinutes: 30,
  closed: false,
  slots: [
    { time: '09:00', available: true },
    { time: '14:00', available: true },
    { time: '15:00', available: true },
  ],
};

beforeEach(() => {
  // Only the clock is faked: real timers keep Testing Library's async helpers working.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-02T14:00:00.000Z') });
  vi.spyOn(servicesApi, 'list').mockResolvedValue([CHECKUP, WHITENING]);
  vi.spyOn(servicesApi, 'availability').mockResolvedValue(DAY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup({ draft = EMPTY_SLOTS, onSubmit = vi.fn() }: { draft?: BookingSlots; onSubmit?: ReturnType<typeof vi.fn> } = {}) {
  const onBooked = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FallbackFormCard reason="requested" draft={draft} onSubmit={onSubmit} onBooked={onBooked} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onSubmit, onBooked, onClose, user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }) };
}

const bookButton = () => screen.getByRole('button', { name: 'Book appointment' });

describe('FallbackFormCard', () => {
  it('starts from what the conversation already understood', async () => {
    setup({ draft: { ...COMPLETE_DRAFT, notes: 'Bring X-rays' } });
    expect(await screen.findByRole('option', { name: /Routine Checkup/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /service/i })).toHaveValue('Routine Checkup');
    expect(screen.getByLabelText(/^Date/)).toHaveValue('2026-10-05');
    expect(await screen.findByRole('radio', { name: '2:00 PM' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('textbox', { name: /notes/i })).toHaveValue('Bring X-rays');
  });

  it('requires a service, a date and a time, using the shared schemas', async () => {
    const { user, onSubmit } = setup();
    await user.click(bookButton());

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toEqual(['Choose a service', 'Choose a date', 'Choose a time']);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a date before today in the business timezone', async () => {
    const { user, onSubmit } = setup({ draft: { ...COMPLETE_DRAFT, date: '2026-10-01' } });
    await user.click(bookButton());
    expect(await screen.findByText('Choose today or a later date')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the slots and hands over to the transcript on success', async () => {
    const booked: AssistantTurnDto = turn({ action: 'booked', appointment: appointment(), bookingDraft: COMPLETE_DRAFT, missing: [] });
    const { user, onSubmit, onBooked } = setup({ draft: COMPLETE_DRAFT, onSubmit: vi.fn().mockResolvedValue(booked) });
    await screen.findByRole('radio', { name: '2:00 PM' });

    await user.click(bookButton());

    await waitFor(() => expect(onBooked).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith({ serviceName: 'Routine Checkup', date: '2026-10-05', time: '14:00', notes: undefined });
  });

  it('clears the chosen time when the date changes, since availability differs by day', async () => {
    const { user } = setup({ draft: COMPLETE_DRAFT });
    await screen.findByRole('radio', { name: '2:00 PM' });

    const date = screen.getByLabelText(/^Date/);
    await user.clear(date);
    await user.type(date, '2026-10-06');

    await waitFor(() => expect(screen.queryByRole('radio', { checked: true })).not.toBeInTheDocument());
  });

  it('keeps what the user picked or typed when a reply changes the draft while the form is open', async () => {
    // A turn can land while the form is on screen (from another tab, or a message
    // sent just before). Untouched fields follow the server; edited ones never move.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const props = { reason: 'requested' as const, onSubmit: vi.fn(), onBooked: vi.fn(), onClose: vi.fn() };
    const ui = (draft: BookingSlots) => (
      <QueryClientProvider client={client}>
        <FallbackFormCard {...props} draft={draft} />
      </QueryClientProvider>
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender } = render(ui({ ...COMPLETE_DRAFT, notes: null }));
    await user.click(await screen.findByRole('radio', { name: '3:00 PM' }));
    await user.type(screen.getByRole('textbox', { name: /notes/i }), 'Mine');

    rerender(ui({ ...COMPLETE_DRAFT, serviceName: 'Teeth Whitening', time: '09:00', notes: 'From the assistant' }));

    await waitFor(() => expect(screen.getByRole('combobox', { name: /service/i })).toHaveValue('Teeth Whitening'));
    expect(await screen.findByRole('radio', { name: '3:00 PM' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('textbox', { name: /notes/i })).toHaveValue('Mine');
  });

  describe('server errors', () => {
    it('a time lost to another booking comes back as a turn: the picker refreshes and the time is cleared', async () => {
      // /chat/draft never answers a booking-rule rejection with an HTTP error;
      // the server clears the time and suggests others in an ordinary turn.
      const taken = turn({
        content: 'Someone just booked 2:00 PM. I could do 3:00 PM — which works?',
        bookingDraft: { ...COMPLETE_DRAFT, time: null },
        missing: ['time'],
        suggestions: [{ date: '2026-10-05', time: '15:00', label: '3:00 PM' }],
      });
      const { user, onBooked } = setup({ draft: COMPLETE_DRAFT, onSubmit: vi.fn().mockResolvedValue(taken) });
      await screen.findByRole('radio', { name: '2:00 PM' });
      expect(servicesApi.availability).toHaveBeenCalledTimes(1);

      vi.mocked(servicesApi.availability).mockResolvedValue({
        ...DAY,
        slots: DAY.slots.map((slot) => ({ ...slot, available: slot.time !== '14:00' })),
      });
      await user.click(bookButton());

      expect(await screen.findByText('Someone just booked 2:00 PM. I could do 3:00 PM — which works?')).toBeInTheDocument();
      expect(screen.getByText('Pick another time from the list.')).toBeInTheDocument();
      await waitFor(() => expect(servicesApi.availability).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByRole('radio', { name: /2:00 PM/ })).toBeDisabled());
      expect(screen.queryByRole('radio', { checked: true })).not.toBeInTheDocument();
      expect(onBooked).not.toHaveBeenCalled();
    });

    it('field-level validation from the server lands next to the field', async () => {
      const invalid = new ApiError({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'Some booking details need attention',
        details: { serviceName: ['We offer: Routine Checkup, Teeth Whitening'] },
      });
      const { user } = setup({ draft: COMPLETE_DRAFT, onSubmit: vi.fn().mockRejectedValue(invalid) });
      await screen.findByRole('radio', { name: '2:00 PM' });

      await user.click(bookButton());
      expect(await screen.findByText('We offer: Routine Checkup, Teeth Whitening')).toBeInTheDocument();
    });

    it('anything else is shown as a form-level alert, with the form still usable', async () => {
      const down = new ApiError({ status: 0, code: 'NETWORK', message: 'We could not reach the server.' });
      const { user } = setup({ draft: COMPLETE_DRAFT, onSubmit: vi.fn().mockRejectedValue(down) });
      await screen.findByRole('radio', { name: '2:00 PM' });

      await user.click(bookButton());
      expect(await screen.findByRole('alert')).toHaveTextContent('We could not reach the server.');
      expect(bookButton()).toBeEnabled();
    });

    it('a turn that is not a booking is explained in place, and the form carries what the server kept', async () => {
      const notBooked = turn({
        content: 'That time is taken. I could do 3:00 PM — which works?',
        bookingDraft: { ...COMPLETE_DRAFT, time: null },
        missing: ['time'],
      });
      const { user, onBooked } = setup({ draft: COMPLETE_DRAFT, onSubmit: vi.fn().mockResolvedValue(notBooked) });
      await screen.findByRole('radio', { name: '2:00 PM' });

      await user.click(bookButton());
      expect(await screen.findByText('That time is taken. I could do 3:00 PM — which works?')).toBeInTheDocument();
      expect(onBooked).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('radio', { checked: true })).not.toBeInTheDocument());
      expect(screen.getByRole('combobox', { name: /service/i })).toHaveValue('Routine Checkup');
    });
  });

  it('closes without submitting', async () => {
    const { user, onClose, onSubmit } = setup();
    await user.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
