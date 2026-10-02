import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ERROR_CODES, type AuthResponse, type UserDto } from '@appt/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { AuthProvider } from '@/providers/AuthProvider';
import { DEMO_ACCOUNT } from './demo-account';
import { LoginForm } from './LoginForm';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));

const mocks = vi.hoisted(() => ({ login: vi.fn() }));

// Only the network boundary is replaced; ApiError, hasErrorCode and the rest of
// the client stay real so the form is exercised against genuine error objects.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  authApi: { login: mocks.login, refresh: vi.fn(), signup: vi.fn(), logout: vi.fn() },
  hasSessionHint: () => false,
}));

const user: UserDto = {
  id: 'u1',
  email: DEMO_ACCOUNT.email,
  fullName: 'Casey Customer',
  phone: null,
  role: 'customer',
  businessId: 'b1',
  businessName: 'Bluewave Dental',
  businessSlug: 'bluewave',
  businessTimezone: 'America/New_York',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const authResponse: AuthResponse = { user, accessToken: 'token', expiresInSeconds: 900 };

function renderForm() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider>
        <LoginForm />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const email = () => screen.getByLabelText(/^Email/);
const password = () => screen.getByLabelText(/^Password/);
const submit = () => screen.getByRole('button', { name: 'Sign in' });

beforeEach(() => {
  vi.resetAllMocks();
});

describe('LoginForm', () => {
  it('explains that the session ended when sent here because of it, and not otherwise', () => {
    window.history.replaceState(null, '', '/login?next=%2Fappointments&expired=1');
    const { unmount } = renderForm();
    expect(screen.getByText('Your session has ended')).toBeInTheDocument();
    unmount();

    window.history.replaceState(null, '', '/login?next=%2Fappointments');
    renderForm();
    expect(screen.queryByText('Your session has ended')).not.toBeInTheDocument();
    window.history.replaceState(null, '', '/');
  });

  it('renders labelled, autocomplete-ready fields', () => {
    renderForm();

    expect(email()).toHaveAttribute('autocomplete', 'email');
    expect(password()).toHaveAttribute('autocomplete', 'current-password');
    expect(password()).toHaveAttribute('type', 'password');
    expect(submit()).toBeEnabled();
  });

  it('validates with the shared schema before calling the API, and focuses the first invalid field', async () => {
    const userEvents = userEvent.setup();
    renderForm();

    await userEvents.click(submit());

    expect(await screen.findAllByText('Required')).toHaveLength(2);
    expect(email()).toHaveAttribute('aria-invalid', 'true');
    expect(email()).toHaveFocus();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('submits the normalised credentials', async () => {
    mocks.login.mockResolvedValue(authResponse);
    const userEvents = userEvent.setup();
    renderForm();

    await userEvents.type(email(), '  Customer@Bluewave.test ');
    await userEvents.type(password(), 'Password123!');
    await userEvents.click(submit());

    await waitFor(() => expect(mocks.login).toHaveBeenCalledTimes(1));
    expect(mocks.login).toHaveBeenCalledWith({ email: 'customer@bluewave.test', password: 'Password123!' });
  });

  it('shows a form-level alert for wrong credentials and returns focus to the password', async () => {
    mocks.login.mockRejectedValue(
      new ApiError({ status: 401, code: ERROR_CODES.INVALID_CREDENTIALS, message: 'Invalid email or password' }),
    );
    const userEvents = userEvent.setup();
    renderForm();

    await userEvents.type(email(), 'customer@bluewave.test');
    await userEvents.type(password(), 'wrong-password');
    await userEvents.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password');
    expect(password()).toHaveFocus();
    expect(submit()).toBeEnabled();
  });

  it('tells the user when to retry after a rate limit', async () => {
    mocks.login.mockRejectedValue(
      new ApiError({ status: 429, code: ERROR_CODES.RATE_LIMITED, message: 'Slow down', retryAfterSeconds: 30 }),
    );
    const userEvents = userEvent.setup();
    renderForm();

    await userEvents.type(email(), 'customer@bluewave.test');
    await userEvents.type(password(), 'Password123!');
    await userEvents.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent('in 30 seconds');
  });

  it('maps server validation details onto the matching field instead of a banner', async () => {
    mocks.login.mockRejectedValue(
      new ApiError({
        status: 400,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Some fields need attention',
        details: { email: ['This email domain is not allowed'] },
      }),
    );
    const userEvents = userEvent.setup();
    renderForm();

    await userEvents.type(email(), 'customer@bluewave.test');
    await userEvents.type(password(), 'Password123!');
    await userEvents.click(submit());

    expect(await screen.findByText('This email domain is not allowed')).toBeInTheDocument();
    expect(email()).toHaveAttribute('aria-invalid', 'true');
    expect(email()).toHaveFocus();
  });

  it('fills the seeded customer login from the demo button', async () => {
    const userEvents = userEvent.setup();
    renderForm();

    await userEvents.click(screen.getByRole('button', { name: 'Use demo account' }));

    expect(email()).toHaveValue(DEMO_ACCOUNT.email);
    expect(password()).toHaveValue(DEMO_ACCOUNT.password);
    expect(submit()).toHaveFocus();
  });

  it('reveals the password only on request', async () => {
    const userEvents = userEvent.setup();
    renderForm();
    const toggle = screen.getByRole('button', { name: 'Show password' });

    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvents.click(toggle);

    expect(password()).toHaveAttribute('type', 'text');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});
