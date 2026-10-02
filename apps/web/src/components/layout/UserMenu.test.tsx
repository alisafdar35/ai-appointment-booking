import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@appt/shared';
import { UserMenu } from './UserMenu';

const EMAIL = 'alexandra.montgomery-whitfield@bluewave-dental-practice.test';

vi.mock('@/providers/AuthProvider', () => ({
  useAuth: () => ({ logout: vi.fn() }),
  useCurrentUser: () =>
    ({ id: 'u1', fullName: 'Alexandra Montgomery', email: EMAIL, role: 'customer', businessName: 'Bluewave Dental' }) as UserDto,
}));

describe('UserMenu', () => {
  it('shows the whole email on hover where the panel truncates it', async () => {
    render(<UserMenu />);
    await userEvent.click(screen.getByRole('button', { name: /Alexandra Montgomery/ }));
    expect(screen.getByText(EMAIL)).toHaveAttribute('title', EMAIL);
  });
});
