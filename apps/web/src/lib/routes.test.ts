import { describe, expect, it } from 'vitest';
import { loginHref, safeNextPath } from './routes';

describe('safeNextPath', () => {
  it('keeps same-origin paths, including query and hash', () => {
    expect(safeNextPath('/appointments')).toBe('/appointments');
    expect(safeNextPath('/appointments?tab=past#top')).toBe('/appointments?tab=past#top');
  });

  it.each([
    'https://evil.example/phish',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'appointments',
    '',
  ])('rejects %j and falls back', (raw) => {
    expect(safeNextPath(raw)).toBe('/assistant');
  });

  it('falls back for missing values and never loops back to an auth page', () => {
    expect(safeNextPath(null)).toBe('/assistant');
    expect(safeNextPath(undefined, '/appointments')).toBe('/appointments');
    expect(safeNextPath('/login?next=/assistant')).toBe('/assistant');
    expect(safeNextPath('/signup')).toBe('/assistant');
  });
});

describe('loginHref', () => {
  it('encodes the destination', () => {
    expect(loginHref('/appointments?tab=past')).toBe('/login?next=%2Fappointments%3Ftab%3Dpast');
  });

  it('marks a sign-in caused by an ended session, so the page can explain it', () => {
    expect(loginHref('/appointments', { expired: true })).toBe('/login?next=%2Fappointments&expired=1');
    expect(loginHref(undefined, { expired: true })).toBe('/login?expired=1');
  });

  it('omits next when there is nothing safe to return to', () => {
    expect(loginHref()).toBe('/login');
    expect(loginHref('https://evil.example')).toBe('/login');
    expect(loginHref('/login')).toBe('/login');
  });
});
