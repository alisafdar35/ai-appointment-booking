import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthAwareAction } from './AuthAwareAction';
import { LandingHeader } from './LandingHeader';

const mocks = vi.hoisted(() => ({ status: 'unauthenticated' as 'loading' | 'authenticated' | 'unauthenticated' }));

vi.mock('@/providers/AuthProvider', () => ({ useAuth: () => ({ status: mocks.status }) }));

beforeEach(() => {
  mocks.status = 'unauthenticated';
});

describe('AuthAwareAction', () => {
  it('invites a signed-out visitor to sign up', () => {
    render(<AuthAwareAction />);
    expect(screen.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/signup');
  });

  it('takes a signed-in user straight into the app', () => {
    mocks.status = 'authenticated';
    render(<AuthAwareAction />);
    expect(screen.getByRole('link', { name: 'Open Slotly' })).toHaveAttribute('href', '/assistant');
  });

  it('shows no link while the session is being restored, so neither label flashes', () => {
    mocks.status = 'loading';
    render(<AuthAwareAction />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('LandingHeader', () => {
  it('offers sign-in to guests only', () => {
    const { rerender } = render(<LandingHeader />);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');

    mocks.status = 'authenticated';
    rerender(<LandingHeader />);
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Slotly' })).toBeInTheDocument();
  });
});
