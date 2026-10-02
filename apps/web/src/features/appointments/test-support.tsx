import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import type { AppointmentDto, ServiceDto } from '@appt/shared';
import { ToastProvider } from '@/providers/ToastProvider';

export const CHECKUP: ServiceDto = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Routine Checkup',
  description: 'A thorough exam and cleaning.',
  durationMinutes: 30,
  priceCents: 8000,
};

export const WHITENING: ServiceDto = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Teeth Whitening',
  description: null,
  durationMinutes: 60,
  priceCents: 15050,
};

/** Dates are far from "now" so upcoming/past never flip during a test run. */
export const FUTURE = { startsAt: '2099-10-05T18:00:00.000Z', endsAt: '2099-10-05T18:30:00.000Z' }; // 2:00 PM EDT
export const PAST = { startsAt: '2020-10-05T18:00:00.000Z', endsAt: '2020-10-05T18:30:00.000Z' };

export function makeAppointment(overrides: Partial<AppointmentDto> = {}): AppointmentDto {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    status: 'confirmed',
    source: 'form',
    ...FUTURE,
    notes: null,
    cancellationReason: null,
    chatSessionId: null,
    createdAt: '2026-10-01T12:00:00.000Z',
    service: CHECKUP,
    customer: { id: 'u0000000-0000-4000-8000-000000000001', fullName: 'Casey Customer', email: 'casey@example.test' },
    ...overrides,
  };
}

/** The wrapper is passed to `render`, so `rerender` keeps the same query client and toast region. */
export function renderWithProviders(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return { client, ...render(ui, { wrapper }) };
}
