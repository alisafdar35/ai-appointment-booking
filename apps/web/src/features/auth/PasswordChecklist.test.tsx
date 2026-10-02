import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PasswordChecklist } from './PasswordChecklist';

const items = () => within(screen.getByRole('list')).getAllByRole('listitem');

describe('PasswordChecklist', () => {
  it('lists the minimum rules from the shared password schema, all unmet for an empty password', () => {
    render(<PasswordChecklist id="rules" value="" />);

    expect(items().map((item) => item.textContent)).toEqual([
      'Must be at least 10 characters: not met yet',
      'Must contain a lowercase letter: not met yet',
      'Must contain an uppercase letter: not met yet',
      'Must contain a number: not met yet',
    ]);
  });

  it('keeps the byte ceiling out of the list until it is exceeded', () => {
    render(<PasswordChecklist id="rules" value="Abcdefghij1" />);

    expect(items().some((item) => item.textContent?.startsWith('Must be at most 72 bytes'))).toBe(false);
  });

  it('never reports completion for a password over bcrypt\'s 72-byte limit', () => {
    // 40 two-byte letters: 80 bytes, although only 43 characters long.
    render(<PasswordChecklist id="rules" value={`Abc1${'é'.repeat(40)}`} />);

    expect(screen.getByRole('status')).toHaveTextContent('4 of 5 password requirements met');
    const cap = items().find((item) => item.textContent?.startsWith('Must be at most 72 bytes'));
    expect(cap).toHaveTextContent('not met yet');
  });

  it('marks only the rules the current value satisfies', () => {
    render(<PasswordChecklist id="rules" value="lowercase" />);

    const byRule = (rule: string) => items().find((item) => item.textContent?.startsWith(rule));
    expect(byRule('Must contain a lowercase letter')).toHaveTextContent(': met');
    expect(byRule('Must be at least 10 characters')).toHaveTextContent('not met yet');
    expect(byRule('Must contain an uppercase letter')).toHaveTextContent('not met yet');
    expect(byRule('Must contain a number')).toHaveTextContent('not met yet');
  });

  it('updates as the password changes and reports completion', () => {
    const { rerender } = render(<PasswordChecklist id="rules" value="Abcdefghij" />);
    expect(screen.getByRole('status')).toHaveTextContent('3 of 4 password requirements met');

    rerender(<PasswordChecklist id="rules" value="Abcdefghij1" />);
    expect(screen.getByRole('status')).toHaveTextContent('All password requirements met');
    expect(items().every((item) => item.textContent?.endsWith(': met'))).toBe(true);
  });

  it('stays silent until the user starts typing', () => {
    render(<PasswordChecklist id="rules" value="" />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('exposes the list under the id used for aria-describedby', () => {
    render(<PasswordChecklist id="rules" value="" />);
    expect(screen.getByRole('list').closest('#rules')).not.toBeNull();
  });
});
