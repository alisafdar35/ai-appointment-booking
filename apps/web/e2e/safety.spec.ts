import { expect, test, type Page } from '@playwright/test';
import { ApiClient, clockTime, findOpenSlot, newAccount, signUpCustomer } from './support/api';
import { messageBox, send, transcript } from './support/chat';

/**
 * Input the app does not control: markup typed into any field, text far
 * longer than anyone should type, and server failures with internals in them.
 */

const MARKUP = [
  '<img src=x onerror="window.__xss=1;alert(1)">',
  '<script>window.__xss=2;alert(2)</script>',
  '<svg onload="window.__xss=3">',
] as const;

/** Fails the test if anything a payload tried to run did run. */
function watchForExecution(page: Page) {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return async () => {
    expect(dialogs, 'no alert() from injected markup').toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(page.locator('img[src="x"], svg[onload]')).toHaveCount(0);
  };
}

/** True when nothing on the page is wider than the viewport. */
const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe('markup is shown as text, never run', () => {
  test('in a name, a chat message and booking notes', async ({ page, request }) => {
    const verify = watchForExecution(page);
    const account = newAccount(`Mallory ${MARKUP[0]}`);
    const api = await ApiClient.connect(request, account, { signUp: true });
    await page.request.post('/api/auth/login', { data: { email: account.email, password: account.password } });
    await page.addInitScript(() => window.localStorage.setItem('slotly.session', '1'));
    const slot = await findOpenSlot(api, 'Routine Checkup');
    await api.book({ serviceId: slot.service.id, date: slot.date, time: slot.time, notes: MARKUP.join(' ') });

    await page.goto('/assistant');
    // The name appears verbatim in the account menu.
    await expect(page.getByRole('button', { name: new RegExp(account.fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeVisible();

    for (const payload of MARKUP.slice(1)) {
      await send(page, payload);
      await expect(transcript(page).getByText(payload, { exact: true })).toBeVisible();
    }

    await page.goto('/appointments');
    await expect(page.getByRole('article', { name: 'Routine Checkup' })).toContainText(MARKUP.join(' '));
    await verify();
  });
});

test.describe('very long input', () => {
  test('a chat message is capped at the limit, and the longest allowed one wraps without breaking the layout', async ({
    page,
  }) => {
    await signUpCustomer(page);
    await page.goto('/assistant');

    await messageBox(page).fill('a'.repeat(2001));
    await expect(page.getByText('1 over the 2,000-character limit')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();

    // One unbroken "word", the hardest case for wrapping.
    const longest = 'b'.repeat(2000);
    await send(page, longest);
    await expect(transcript(page).getByText(longest)).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    const bubble = await transcript(page).getByText(longest).boundingBox();
    const log = await transcript(page).boundingBox();
    expect(bubble!.x + bubble!.width).toBeLessThanOrEqual(log!.x + log!.width + 1);
  });

  test('booking notes are capped at the limit, and long notes wrap on the card', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Teeth Whitening');
    let posts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/appointments') posts++;
    });

    await page.goto('/appointments');
    await page.getByRole('button', { name: 'New appointment' }).click();
    const dialog = page.getByRole('dialog', { name: 'New appointment' });
    await dialog.getByText('Teeth Whitening', { exact: true }).click();
    await dialog.getByLabel('Date').fill(slot.date);
    await dialog.getByRole('radio', { name: clockTime(slot.time), exact: true }).click();

    await dialog.getByLabel('Notes (optional)').fill('n'.repeat(2001));
    await expect(dialog.getByText('Keep your notes to 2000 characters or fewer.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    await expect(dialog).toBeVisible();
    expect(posts).toBe(0);

    const notes = 'n'.repeat(2000);
    await dialog.getByLabel('Notes (optional)').fill(notes);
    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    await expect(dialog).toBeHidden();
    const card = page.getByRole('article', { name: 'Teeth Whitening' });
    await expect(card).toContainText(notes);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });
});

test.describe('unexpected server errors', () => {
  const INTERNALS = /relation "|SELECT |pg-protocol|node_modules|at Parser|TypeError|\.js:\d+/;

  test('show a useful message and never the stack, SQL or debug detail behind them', async ({ page }) => {
    await signUpCustomer(page);
    await page.route('**/api/appointments?**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'INTERNAL',
            message: 'Something went wrong on our side.',
            requestId: 'e2e-req',
            debug: 'error: relation "appointments" does not exist\n    at Parser.parseErrorMessage (node_modules/pg-protocol/dist/parser.js:283:98)',
          },
        }),
      }),
    );
    await page.route('**/api/chat/messages', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'text/html',
        body: '<html><body><pre>TypeError: Cannot read properties of undefined\n    at handler (/srv/api/dist/index.js:1:1)\nSELECT * FROM users</pre></body></html>',
      }),
    );

    await page.goto('/appointments');
    await expect(page.getByRole('alert').filter({ hasText: "We couldn't load your appointments" })).toContainText(
      'Something went wrong on our side.',
      { timeout: 20_000 },
    );
    await expect(page.locator('body')).not.toContainText(INTERNALS);

    await page.getByRole('link', { name: 'Assistant' }).click();
    await messageBox(page).fill('Routine checkup please');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await messageBox(page).press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'temporarily unavailable' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(INTERNALS);
  });
});
