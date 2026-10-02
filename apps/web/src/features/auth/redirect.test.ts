import { describe, expect, it } from 'vitest';
import { ROUTES } from '@/lib/routes';
import { authPageHref } from './redirect';

describe('authPageHref', () => {
  it('returns the bare route when there is nothing to carry over', () => {
    expect(authPageHref(ROUTES.signup, null)).toBe('/signup');
    expect(authPageHref(ROUTES.login, undefined)).toBe('/login');
    expect(authPageHref(ROUTES.login, '')).toBe('/login');
  });

  it('carries a same-origin path across, encoded, including its query string and hash', () => {
    expect(authPageHref(ROUTES.signup, '/appointments')).toBe('/signup?next=%2Fappointments');
    expect(authPageHref(ROUTES.login, '/appointments?status=confirmed#top')).toBe(
      '/login?next=%2Fappointments%3Fstatus%3Dconfirmed%23top',
    );
  });

  it.each([
    ['an absolute URL', 'https://evil.example/phish'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash host', '/\\evil.example'],
    ['a doubled backslash host', '\\\\evil.example'],
    ['a tab hidden inside the slashes', '/\t/evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a path without a leading slash', 'evil.example'],
    ['a userinfo trick', '//trusted.example@evil.example'],
  ])('never carries %s into a link', (_label, raw) => {
    expect(authPageHref(ROUTES.login, raw)).toBe('/login');
  });

  it('drops a destination that would bounce a signed-in user back to an auth page', () => {
    expect(authPageHref(ROUTES.signup, '/login')).toBe('/signup');
    expect(authPageHref(ROUTES.login, '/signup?next=/appointments')).toBe('/login');
  });
});
