import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

function setup(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn<(text: string) => boolean>(() => true);
  const onToggleForm = vi.fn();
  render(<Composer onSend={onSend} sending={false} formOpen={false} onToggleForm={onToggleForm} {...props} />);
  return { onSend, onToggleForm, textbox: screen.getByRole('textbox', { name: 'Message' }) };
}

describe('Composer', () => {
  it('sends on Enter and clears the box', async () => {
    const { onSend, textbox } = setup();
    await userEvent.type(textbox, 'Book a checkup{Enter}');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Book a checkup');
    expect(textbox).toHaveValue('');
  });

  it('adds a new line on Shift+Enter instead of sending', async () => {
    const { onSend, textbox } = setup();
    await userEvent.type(textbox, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(onSend).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('line one\nline two');
  });

  it('ignores Enter while an IME composition is active', () => {
    const { onSend, textbox } = setup();
    fireEvent.change(textbox, { target: { value: 'にほん' } });

    fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textbox, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('にほん');

    fireEvent.keyDown(textbox, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledExactlyOnceWith('にほん');
  });

  it('disables Send while the box is empty or only whitespace', async () => {
    const { textbox } = setup();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await userEvent.type(textbox, '   ');
    expect(send).toBeDisabled();
    await userEvent.type(textbox, 'hi');
    expect(send).toBeEnabled();
  });

  it('sends with the Send button', async () => {
    const { onSend, textbox } = setup();
    await userEvent.type(textbox, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith('hello');
  });

  it('keeps the text when the message was not accepted', async () => {
    const { textbox } = setup({ onSend: vi.fn(() => false) });
    await userEvent.type(textbox, 'hello{Enter}');
    expect(textbox).toHaveValue('hello');
  });

  it('lets you type ahead while a reply is pending, but does not send', async () => {
    const { onSend, textbox } = setup({ sending: true });
    await userEvent.type(textbox, 'next thing{Enter}');
    expect(textbox).toHaveValue('next thing');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('holds sending, visibly, until the conversation is ready', async () => {
    const { onSend, textbox } = setup({ ready: false });
    await userEvent.type(textbox, 'hello{Enter}');
    expect(textbox).toHaveValue('hello');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  describe('length limit', () => {
    it('shows no counter for an ordinary message', async () => {
      const { textbox } = setup();
      await userEvent.type(textbox, 'short');
      expect(screen.queryByText(/\/ 2,000/)).not.toBeInTheDocument();
    });

    it('shows the count near the limit', () => {
      const { textbox } = setup();
      fireEvent.change(textbox, { target: { value: 'a'.repeat(1900) } });
      expect(screen.getByText('1,900 / 2,000')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });

    it('flags a message over the limit, blocks sending and keeps the text', () => {
      const { onSend, textbox } = setup();
      fireEvent.change(textbox, { target: { value: 'a'.repeat(2005) } });
      expect(screen.getByRole('alert')).toHaveTextContent('5 over the 2,000-character limit');
      expect(textbox).toBeInvalid();
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      fireEvent.keyDown(textbox, { key: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();
      expect(textbox).toHaveValue('a'.repeat(2005));
    });
  });

  it('always offers the form, and reports its state', async () => {
    const { onToggleForm } = setup();
    const toggle = screen.getByRole('button', { name: 'Prefer a form?' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(onToggleForm).toHaveBeenCalledOnce();
  });
});
