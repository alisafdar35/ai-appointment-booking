import { describe, expect, it } from 'vitest';
import { appointment } from '../test/factories';
import { nextAppointments } from './upcoming';

describe('nextAppointments', () => {
  it('takes the first three of the list as the server ordered and filtered it', () => {
    const ids = ['soon', 'next', 'later', 'last'];
    const result = nextAppointments(ids.map((id) => appointment({ id })));
    expect(result.map((entry) => entry.id)).toEqual(['soon', 'next', 'later']);
  });

  it('is empty while the list has not loaded', () => {
    expect(nextAppointments(undefined)).toEqual([]);
  });
});
