import { describe, expect, it } from 'vitest';
import { cn, formatPrice, initials, pluralize } from './utils';

describe('cn', () => {
  it('drops falsy values and lets later Tailwind utilities win', () => {
    expect(cn('px-2 py-1', false && 'hidden', 'px-4')).toBe('py-1 px-4');
  });

  it('treats custom shadow tokens as one property', () => {
    expect(cn('shadow-sm', 'shadow-card')).toBe('shadow-card');
  });
});

describe('initials', () => {
  it.each([
    ['Ada Lovelace', 'AL'],
    ['  grace   brewster   hopper ', 'GH'],
    ['Ada', 'AD'],
    ['x', 'X'],
    ['', '?'],
  ])('%j -> %s', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

describe('formatPrice', () => {
  it('omits cents for whole-dollar amounts', () => {
    expect(formatPrice(4500)).toBe('$45');
  });

  it('calls a zero price free', () => {
    expect(formatPrice(0)).toBe('Free');
  });

  it('shows two decimals otherwise', () => {
    expect(formatPrice(4550)).toBe('$45.50');
    expect(formatPrice(5)).toBe('$0.05');
  });
});

describe('pluralize', () => {
  it('chooses the form by count', () => {
    expect(pluralize(0, 'service')).toBe('0 services');
    expect(pluralize(1, 'service')).toBe('1 service');
    expect(pluralize(2, 'appointment')).toBe('2 appointments');
    expect(pluralize(2, 'person', 'people')).toBe('2 people');
  });
});
