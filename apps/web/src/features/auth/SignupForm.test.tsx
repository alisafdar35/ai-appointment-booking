import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ERROR_CODES, type AuthResponse, type UserDto } from '@appt/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { AuthProvider } from '@/providers/AuthProvider';
import { SignupForm } from './SignupForm';

const mocks = vi.hoisted(() => ({ signup: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  authApi: { signup: mocks.signup, login: vi.fn(), refresh: vi.fn(), logout: vi.fn() },
  hasSessionHint: () => false,
}));

const user: UserDto = {
  id: 'u1',
  email: 'casey@example.test',
  fullName: 'Casey Customer',
  phone: null,
  role: 'owner',
  businessId: 'b1',
  businessName: 'Casey Dental',
  businessSlug: 'casey-dental',
  businessTimezone: 'UTC',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const authResponse: AuthResponse = { user, accessToken: 'token', expiresInSeconds: 900 };

function renderForm() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider>
        <SignupForm />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function fillAccount(userEvents: ReturnType<typeof userEvent.setup>) {
  await userEvents.type(screen.getByLabelText(/^Full name/), 'Casey Customer');
  await userEvents.type(screen.getByLabelText(/^Email/), 'casey@example.test');
  await userEvents.type(screen.getByLabelText(/^Password/), 'Sufficient1password');
}

const submit = () => screen.getByRole('button', { name: 'Create account' });

beforeEach(() => {
  vi.resetAllMocks();
});

describe('SignupForm', () => {
  it('uses new-password autocomplete and shows the live password checklist', async () => {
    const userEvents = userEvent.setup();
    renderForm();
    const password = screen.getByLabelText(/^Password/);

    expect(password).toHaveAttribute('autocomplete', 'new-password');
    expect(password).toHaveAccessibleDescription(/Must be at least 10 characters/);

    await userEvents.type(password, 'Sufficient1password');
    expect(screen.getByRole('status')).toHaveTextContent('All password requirements met');
  });

  it('starts on joining an existing business with an empty code, and asks for the field that matches the mode', async () => {
    const userEvents = userEvent.setup();
    renderForm();

    expect(screen.getByRole('radio', { name: 'Join an existing business' })).toBeChecked();
    expect(screen.getByLabelText(/^Business code/)).toHaveValue('');
    await userEvents.click(screen.getByRole('radio', { name: 'Create a new business' }));

    expect(screen.queryByLabelText(/^Business code/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Business name/)).toBeInTheDocument();
  });

  it('blocks submission and flags the missing business name', async () => {
    const userEvents = userEvent.setup();
    renderForm();
    await fillAccount(userEvents);
    await userEvents.click(screen.getByRole('radio', { name: 'Create a new business' }));

    await userEvents.click(submit());

    expect(await screen.findByText('Enter your business name')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Business name/)).toHaveFocus();
    expect(mocks.signup).not.toHaveBeenCalled();
  });

  it('creates a business with only the business name in the request', async () => {
    mocks.signup.mockResolvedValue(authResponse);
    const userEvents = userEvent.setup();
    renderForm();
    await fillAccount(userEvents);
    await userEvents.click(screen.getByRole('radio', { name: 'Create a new business' }));
    await userEvents.type(screen.getByLabelText(/^Business name/), 'Casey Dental');

    await userEvents.click(submit());

    await waitFor(() => expect(mocks.signup).toHaveBeenCalledTimes(1));
    expect(mocks.signup).toHaveBeenCalledWith({
      fullName: 'Casey Customer',
      email: 'casey@example.test',
      password: 'Sufficient1password',
      businessName: 'Casey Dental',
    });
  });

  it('puts an unknown business code on the code field', async () => {
    mocks.signup.mockRejectedValue(
      new ApiError({
        status: 400,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Some fields need attention',
        details: { businessSlug: ['No business with that name was found'] },
      }),
    );
    const userEvents = userEvent.setup();
    renderForm();
    await fillAccount(userEvents);
    await userEvents.click(screen.getByRole('radio', { name: 'Join an existing business' }));
    await userEvents.type(screen.getByLabelText(/^Business code/), 'nowhere');

    await userEvents.click(submit());

    expect(await screen.findByText('No business with that name was found')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Business code/)).toHaveFocus();
  });

  it('puts a duplicate email on the email field', async () => {
    mocks.signup.mockRejectedValue(
      new ApiError({ status: 409, code: ERROR_CODES.EMAIL_TAKEN, message: 'An account with this email already exists' }),
    );
    const userEvents = userEvent.setup();
    renderForm();
    await fillAccount(userEvents);
    await userEvents.click(screen.getByRole('radio', { name: 'Create a new business' }));
    await userEvents.type(screen.getByLabelText(/^Business name/), 'Casey Dental');

    await userEvents.click(submit());

    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/)).toHaveFocus();
  });

  it('falls back to a form-level alert for anything else', async () => {
    mocks.signup.mockRejectedValue(new ApiError({ status: 0, code: 'NETWORK', message: 'Network error' }));
    const userEvents = userEvent.setup();
    renderForm();
    await fillAccount(userEvents);
    await userEvents.click(screen.getByRole('radio', { name: 'Create a new business' }));
    await userEvents.type(screen.getByLabelText(/^Business name/), 'Casey Dental');

    await userEvents.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach Slotly');
  });
});
