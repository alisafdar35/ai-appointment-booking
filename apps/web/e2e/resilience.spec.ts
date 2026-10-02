import { expect, test, type Route } from '@playwright/test';
import { signUpCustomer } from './support/api';
import { messageBox, transcript } from './support/chat';

/**
 * What the UI does when the API fails. Failures are injected with route
 * interception, so the real stack stays up and only the response the page sees
 * changes; each test then removes the fault and checks the recovery path.
 */

const CHAT_MESSAGES = '**/api/chat/messages';

const apiError = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  (route: Route) =>
    route.fulfill({
      status,
      headers,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code, message, requestId: 'e2e-injected' } }),
    });

test.describe('sending a chat message', () => {
  test.beforeEach(async ({ page }) => {
    await signUpCustomer(page);
    await page.goto('/assistant');
  });

  test('keeps a message the server failed on, and sends it again on Retry', async ({ page }) => {
    await page.route(CHAT_MESSAGES, apiError(500, 'INTERNAL_ERROR', 'Something went wrong on our side.'));
    await messageBox(page).fill('I need a routine checkup');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await messageBox(page).press('Enter');

    const failure = page.getByRole('alert').filter({ hasText: 'Something went wrong on our side.' });
    await expect(failure).toBeVisible();
    await expect(transcript(page).getByText('I need a routine checkup')).toBeVisible();

    await page.unroute(CHAT_MESSAGES);
    await failure.getByRole('button', { name: 'Retry' }).click();
    await expect(failure).toBeHidden();
    await expect(transcript(page).getByText(/Routine Checkup\. What day and time would suit you\?/)).toBeVisible();
  });

  test('says when the server cannot be reached', async ({ page }) => {
    await page.route(CHAT_MESSAGES, (route) => route.abort('internetdisconnected'));
    await messageBox(page).fill('Teeth whitening please');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await messageBox(page).press('Enter');

    const failure = page.getByRole('alert').filter({ hasText: "Couldn't reach the server. Check your connection and try again." });
    await expect(failure.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  test('waits out a rate limit for as long as the server asks before allowing a retry', async ({ page }) => {
    await page.route(
      CHAT_MESSAGES,
      apiError(429, 'RATE_LIMITED', 'Too many requests. Try again in 3 seconds.', { 'Retry-After': '3' }),
    );
    await messageBox(page).fill('Emergency consult please');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await messageBox(page).press('Enter');

    const failure = page.getByRole('alert').filter({ hasText: "You're sending messages quickly." });
    await expect(failure.getByRole('button', { name: /^Retry in \ds$/ })).toBeDisabled();

    await page.unroute(CHAT_MESSAGES);
    await failure.getByRole('button', { name: 'Retry', exact: true }).click({ timeout: 6_000 });
    await expect(transcript(page).getByText(/Emergency Consult\. What day and time would suit you\?/)).toBeVisible();
  });
});

test('the dashboard explains a failed load, stops its loading state, and recovers on Try again', async ({ page }) => {
  await signUpCustomer(page);
  const LISTS = '**/api/appointments?**';
  await page.route(LISTS, apiError(500, 'INTERNAL_ERROR', 'The server had a problem.'));
  await page.goto('/appointments');

  const alert = page.getByRole('alert').filter({ hasText: "We couldn't load your appointments" });
  // The query retries before giving up; allow for its backoff.
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Appointment summary').getByText('Unavailable')).toHaveCount(3);

  await page.unroute(LISTS);
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Nothing coming up')).toBeVisible();
});
