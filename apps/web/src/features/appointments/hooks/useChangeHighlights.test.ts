import { act, renderHook } from '@testing-library/react';
import type { AppointmentDto } from '@appt/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAppointment } from '../test-support';
import { useChangeHighlights } from './useChangeHighlights';

const first = makeAppointment({ id: 'a0000000-0000-4000-8000-000000000001' });
const second = makeAppointment({ id: 'a0000000-0000-4000-8000-000000000002' });

function setup(initial: AppointmentDto[] | undefined, scope = 'upcoming') {
  return renderHook(({ items, scope }) => useChangeHighlights(items, scope), { initialProps: { items: initial, scope } });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useChangeHighlights', () => {
  it('treats the first load as a baseline, not as news', () => {
    const { result, rerender } = setup(undefined);
    rerender({ items: [first], scope: 'upcoming' });
    expect(result.current.highlightedIds.size).toBe(0);
  });

  it('highlights an appointment that arrives later, then lets it fade', () => {
    const { result, rerender } = setup([first]);
    rerender({ items: [first, second], scope: 'upcoming' });
    expect([...result.current.highlightedIds]).toEqual([second.id]);

    act(() => void vi.advanceTimersByTime(4000));
    expect(result.current.highlightedIds.size).toBe(0);
  });

  it('highlights an appointment that changed in place', () => {
    const { result, rerender } = setup([first]);
    rerender({ items: [{ ...first, notes: 'Running late' }], scope: 'upcoming' });
    expect([...result.current.highlightedIds]).toEqual([first.id]);
  });

  it('does not react to a new array with identical content', () => {
    const { result, rerender } = setup([first]);
    rerender({ items: [{ ...first }], scope: 'upcoming' });
    expect(result.current.highlightedIds.size).toBe(0);
  });

  it('starts a fresh baseline when the scope changes, so switching tabs highlights nothing', () => {
    const { result, rerender } = setup([first], 'upcoming');
    rerender({ items: [second], scope: 'past' });
    expect(result.current.highlightedIds.size).toBe(0);
  });

  it('can be told to highlight an id directly', () => {
    const { result } = setup([first]);
    act(() => result.current.highlight([first.id]));
    expect(result.current.highlightedIds.has(first.id)).toBe(true);
  });
});
