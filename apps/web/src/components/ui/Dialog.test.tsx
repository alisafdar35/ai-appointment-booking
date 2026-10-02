import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

function Harness({ onOpenChange = () => {}, dismissible = true }: { onOpenChange?: (open: boolean) => void; dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
        title="Cancel appointment"
        description="This frees the slot for someone else."
        dismissible={dismissible}
        footer={
          <>
            <button data-autofocus>Keep it</button>
            <button>Cancel it</button>
          </>
        }
      >
        <input aria-label="Reason" />
      </Dialog>
    </>
  );
}

async function openDialog() {
  render(<Harness />);
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: 'Open dialog' });
  await user.click(trigger);
  return { user, trigger };
}

describe('Dialog', () => {
  it('is a labelled, described modal dialog', async () => {
    await openDialog();
    const dialog = screen.getByRole('dialog', { name: 'Cancel appointment' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('This frees the slot for someone else.');
  });

  it('moves focus to the [data-autofocus] control on open', async () => {
    await openDialog();
    expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus();
  });

  it('closes on Escape and returns focus to the element that opened it', async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(trigger);

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('traps Tab and Shift+Tab inside the panel', async () => {
    const { user } = await openDialog();
    const keep = screen.getByRole('button', { name: 'Keep it' });
    const closeIcon = screen.getByRole('button', { name: 'Close dialog' });

    // Content first, close icon last in DOM order: tabbing forward from the last wraps to the first.
    closeIcon.focus();
    await user.tab();
    expect(screen.getByLabelText('Reason')).toHaveFocus();

    // Shift+Tab from the first wraps to the last.
    await user.tab({ shift: true });
    expect(closeIcon).toHaveFocus();

    keep.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel it' })).toHaveFocus();
  });

  it('closes when the backdrop is clicked, but not when the panel is', async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));

    await user.click(screen.getByRole('dialog'));
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('dialog').parentElement!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('locks page scroll while open and restores it after', async () => {
    const { user } = await openDialog();
    expect(document.body.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('');
  });

  it('ignores Escape when not dismissible', async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} dismissible={false} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));

    await user.keyboard('{Escape}');

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument();
  });
});
