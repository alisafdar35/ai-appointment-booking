import { expect, test, type Page } from '@playwright/test';
import { SEEDED_USERS, signInViaApi } from './support/session';

const { customer } = SEEDED_USERS;
const liveStatus = (page: Page) => page.getByTitle(/other tabs or devices|keep retrying/);

test.describe('route protection', () => {
  test('sends an anonymous visitor to sign-in and remembers the destination', async ({ page }) => {
    await page.goto('/appointments');

    await expect(page).toHaveURL(/\/login\?next=%2Fappointments$/);
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  });

  test('does not call the API at all for a visitor who has never signed in', async ({ page }) => {
    const refreshCalls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/auth/refresh')) refreshCalls.push(request.url());
    });

    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

    expect(refreshCalls).toEqual([]);
  });
});

test.describe('signed-in session', () => {
  test.beforeEach(async ({ page }) => {
    await signInViaApi(page, customer);
  });

  test('restores from the refresh cookie after a reload and shows the app shell', async ({ page }) => {
    await page.goto('/assistant');

    await expect(page.getByRole('heading', { name: 'Assistant' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Assistant' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('button', { name: new RegExp(customer.fullName) })).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/\/assistant$/);
    await expect(page.getByRole('heading', { name: 'Assistant' })).toBeVisible();
  });

  test('navigates between sections with the primary nav', async ({ page }) => {
    await page.goto('/assistant');

    await page.getByRole('link', { name: 'Appointments' }).click();

    await expect(page).toHaveURL(/\/appointments$/);
    await expect(page.getByRole('link', { name: 'Appointments' })).toHaveAttribute('aria-current', 'page');
  });

  test('shows the live status once the socket connects', async ({ page }) => {
    await page.goto('/assistant');

    await expect(liveStatus(page)).toContainText('Live');
  });

  test('keeps working, and says so, when live updates cannot connect', async ({ page }) => {
    await page.routeWebSocket(/socket\.io/, (socket) => socket.close());
    await page.route(/socket\.io/, (route) => route.abort());

    await page.goto('/assistant');

    // The mocked handshake never completes, so the client gives up after its connect timeout.
    await expect(liveStatus(page)).toContainText(/Live updates unavailable|Offline/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Assistant' })).toBeVisible();
    await page.getByRole('link', { name: 'Appointments' }).click();
    await expect(page.getByRole('heading', { name: 'Appointments' })).toBeVisible();
  });

  test('sign-in pages send a signed-in user onward, but only to same-origin destinations', async ({ page }) => {
    await page.goto('/login?next=https://evil.example/phish');
    await expect(page).toHaveURL(/\/assistant$/);

    await page.goto('/login?next=/appointments');
    await expect(page).toHaveURL(/\/appointments$/);
  });

  test('signing out ends the session and protects the routes again', async ({ page }) => {
    await page.goto('/assistant');

    await page.getByRole('button', { name: new RegExp(customer.fullName) }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();

    // The user chose to leave, so there is no "next" to return to.
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/assistant');
    // signInViaApi's init script puts the "signed in before" hint back on every load (the app itself
    // removed it), so the page tries the dead refresh cookie and says the session has ended.
    await expect(page).toHaveURL(/\/login\?next=%2Fassistant(&expired=1)?$/);
  });
});
