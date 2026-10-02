import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContextValue } from '@/providers/AuthProvider';
import { SessionRestoreNotice } from './SessionRestoreNotice';

const auth = vi.hoisted(() => ({ current: {} as Partial<AuthContextValue> }));
vi.mock('@/providers/AuthProvider', () => ({ useAuth: () => auth.current }));

describe('SessionRestoreNotice', () => {
  it('says nothing while the check is quick', () => {
    auth.current = { status: 'loading', restore: 'checking' };
    const { container } = render(<SessionRestoreNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains a slow start calmly', () => {
    auth.current = { status: 'loading', restore: 'waking' };
    render(<SessionRestoreNotice />);
    expect(screen.getByRole('status')).toHaveTextContent('Waking up the server');
  });

  it('offers Try again once the attempts are used up', async () => {
    const retryRestore = vi.fn();
    auth.current = { status: 'loading', restore: 'unreachable', retryRestore };
    render(<SessionRestoreNotice />);
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't reach Slotly");
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retryRestore).toHaveBeenCalledOnce();
  });
});
