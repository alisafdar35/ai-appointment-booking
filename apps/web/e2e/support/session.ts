import { expect, type Page } from '@playwright/test';

/** Seeded by `npm run db:seed`; see db/seed.sql. */
export const SEEDED_PASSWORD = 'Password123!';
export const SEEDED_USERS = {
  customer: { email: 'customer@bluewave.test', fullName: 'Marcus Reed', business: 'Bluewave Dental' },
  owner: { email: 'owner@bluewave.test', fullName: 'Dana Whitfield', business: 'Bluewave Dental' },
  staff: { email: 'staff@bluewave.test', fullName: 'Priya Raman', business: 'Bluewave Dental' },
} as const;

/**
 * Sign in without touching the UI: log in through the proxied API (the page's
 * request context shares the browser's cookie jar), then set the same
 * "signed in before" hint the app writes after a real login. Specs that are
 * not *about* the login form use this so they stay fast and independent of it.
 */
export async function signInViaApi(page: Page, user: { email: string } = SEEDED_USERS.customer): Promise<void> {
  const response = await page.request.post('/api/auth/login', {
    data: { email: user.email, password: SEEDED_PASSWORD },
  });
  expect(response.ok(), `login as ${user.email} should succeed`).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem('slotly.session', '1'));
}
