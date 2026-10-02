import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import type { AvailabilityDto } from '@appt/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, servicesApi } from '@/lib/api';
import { SlotPicker } from './SlotPicker';

vi.mock('@/providers/AuthProvider', () => ({ useBusinessTimezone: () => 'America/New_York' }));

const availability = (slots: AvailabilityDto['slots']): AvailabilityDto => ({
  date: '2026-10-05',
  serviceId: 'svc',
  closed: false,
  durationMinutes: 30,
  slots,
});

const MIXED = availability([
  { time: '09:00', available: true },
  { time: '09:30', available: false },
  { time: '10:00', available: true },
  { time: '13:30', available: true },
]);

function Harness({ initial = null }: { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return <SlotPicker serviceId="svc" date="2026-10-05" value={value} onChange={setValue} />;
}

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => vi.restoreAllMocks());

describe('SlotPicker', () => {
  it('asks for a service and date before fetching anything', () => {
    const spy = vi.spyOn(servicesApi, 'availability');
    renderWithClient(<SlotPicker serviceId={undefined} date="2026-10-05" value={null} onChange={() => {}} />);
    expect(screen.getByText(/choose a service and a date/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('announces loading while the grid is a skeleton', () => {
    vi.spyOn(servicesApi, 'availability').mockReturnValue(new Promise(() => {}));
    renderWithClient(<Harness />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading available times');
  });

  it('shows 12-hour labels, keeps unavailable slots visible but disabled, and names the zone', async () => {
    vi.spyOn(servicesApi, 'availability').mockResolvedValue(MIXED);
    renderWithClient(<Harness />);

    const group = await screen.findByRole('radiogroup', { name: 'Available times' });
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.textContent)).toEqual(['9:00 AM', '9:30 AM (unavailable)', '10:00 AM', '1:30 PM']);
    expect(screen.getByRole('radio', { name: /9:30 AM/ })).toBeDisabled();
    expect(group).toBeInTheDocument();
    expect(screen.getByText(/30-minute appointment · times shown in EDT/)).toBeInTheDocument();
  });

  it('says the business is closed that day, rather than merely full, when the API says so', async () => {
    vi.spyOn(servicesApi, 'availability').mockResolvedValue({ ...availability([]), closed: true });
    renderWithClient(<Harness />);
    expect(await screen.findByText('Closed on this day')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('selects on click and reports the 24-hour value', async () => {
    vi.spyOn(servicesApi, 'availability').mockResolvedValue(MIXED);
    renderWithClient(<Harness />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('radio', { name: '1:30 PM' }));

    expect(screen.getByRole('radio', { name: '1:30 PM' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '9:00 AM' })).toHaveAttribute('aria-checked', 'false');
  });

  it('is one Tab stop: the selected slot, else the first available', async () => {
    vi.spyOn(servicesApi, 'availability').mockResolvedValue(MIXED);
    const { unmount } = renderWithClient(<Harness />);
    await screen.findByRole('radiogroup');
    expect(screen.getByRole('radio', { name: '9:00 AM' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: '10:00 AM' })).toHaveAttribute('tabindex', '-1');
    unmount();

    renderWithClient(<Harness initial="10:00" />);
    await screen.findByRole('radiogroup');
    expect(screen.getByRole('radio', { name: '10:00 AM' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: '9:00 AM' })).toHaveAttribute('tabindex', '-1');
  });

  it('arrow keys move between available slots, select as they go, and wrap', async () => {
    vi.spyOn(servicesApi, 'availability').mockResolvedValue(MIXED);
    renderWithClient(<Harness />);
    const user = userEvent.setup();
    await screen.findByRole('radiogroup');
    screen.getByRole('radio', { name: '9:00 AM' }).focus();

    await user.keyboard('{ArrowRight}'); // skips the unavailable 9:30
    expect(screen.getByRole('radio', { name: '10:00 AM' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: '10:00 AM' })).toHaveAttribute('aria-checked', 'true');

    await user.keyboard('{End}');
    expect(screen.getByRole('radio', { name: '1:30 PM' })).toHaveFocus();

    await user.keyboard('{ArrowDown}'); // wraps
    expect(screen.getByRole('radio', { name: '9:00 AM' })).toHaveFocus();

    await user.keyboard('{ArrowLeft}'); // wraps back
    expect(screen.getByRole('radio', { name: '1:30 PM' })).toHaveFocus();
  });

  it('shows an empty state when the business has no slots that day', async () => {
    vi.spyOn(servicesApi, 'availability').mockResolvedValue(availability([]));
    renderWithClient(<Harness />);
    expect(await screen.findByText('No availability on this date')).toBeInTheDocument();
    expect(screen.getByText(/try another day/i)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('keeps a fully booked day visible but disabled, with a message', async () => {
    vi.spyOn(servicesApi, 'availability').mockResolvedValue(
      availability([
        { time: '09:00', available: false },
        { time: '09:30', available: false },
      ]),
    );
    renderWithClient(<Harness />);
    expect(await screen.findByText(/fully booked on this date/i)).toBeInTheDocument();
    screen.getAllByRole('radio').forEach((radio) => expect(radio).toBeDisabled());
  });

  it('offers a retry when loading fails', async () => {
    const spy = vi
      .spyOn(servicesApi, 'availability')
      .mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK', message: 'We could not reach the server.' }))
      .mockResolvedValue(MIXED);
    renderWithClient(<Harness />);
    const user = userEvent.setup();

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not reach the server.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByRole('radiogroup')).toBeInTheDocument());
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
