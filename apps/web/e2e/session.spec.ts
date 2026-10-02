import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ApiClient, clockTime, findOpenSlot, newAccount, signUpCustomer, type Account } from './support/api';

/**
 * The session's whole life as the user sees it: signing in through the form,
 * signing out (and what is left behind), and a session that ends on its own
 * while the user is mid-task.
 */

const AUTH_COOKIES = ['appt_access', 'appt_refresh'];

const authCookies = async (context: BrowserContext) =>
  (await context.cookies()).filter((cookie) => AUTH_COOKIES.includes(cookie.name) && cookie.value !== '');

async function signInWithForm(page: Page, account: Account) {
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel(/^Password/).first().fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('signing out clears the session: no auth cookies, a closed socket, and Back cannot show protected data', async ({
  page,
  context,
  request,
}) => {
  const account = newAccount('Ines Moreau');
  const api = await ApiClient.connect(request, account, { signUp: true });
  const slot = await findOpenSlot(api, 'Routine Checkup');
  const note = `Private note ${account.email}`;
  await api.book({ serviceId: slot.service.id, date: slot.date, time: slot.time, notes: note });

  const sockets: { isClosed: () => boolean }[] = [];
  page.on('websocket', (socket) => sockets.push(socket));

  await page.goto('/login');
  await signInWithForm(page, account);
  await expect(page).toHaveURL(/\/assistant$/);
  await page.getByRole('link', { name: 'Appointments' }).click();
  await expect(page.getByRole('article', { name: 'Routine Checkup' })).toContainText(note);
  expect((await authCookies(context)).map((cookie) => cookie.name).sort()).toEqual(AUTH_COOKIES);
  await expect.poll(() => sockets.some((socket) => !socket.isClosed())).toBe(true);

  await page.getByRole('button', { name: new RegExp(account.fullName) }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // The browser holds no credential, and the realtime connection (which used the in-memory token) is gone.
  expect(await authCookies(context)).toEqual([]);
  await expect.poll(() => sockets.every((socket) => socket.isClosed())).toBe(true);
  // The server revoked the refresh token, so it would not work even if it had been kept.
  expect((await page.request.post('/api/auth/refresh')).status()).toBe(401);
  // The "signed in before" hint is gone too.
  expect(await page.evaluate(() => window.localStorage.getItem('slotly.session'))).toBeNull();

  // Back returns to a protected page, which sends the visitor to sign in without rendering its data;
  // so does opening the dashboard directly.
  await page.goBack();
  await expect(page).toHaveURL(/\/login/);
  await expectSignedOutView(page, [note, account.fullName]);
  await page.goto('/appointments');
  await expect(page).toHaveURL(/\/login\?next=%2Fappointments$/);
  await expectSignedOutView(page, [note, account.fullName]);
});

async function expectSignedOutView(page: Page, privateTexts: string[]) {
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  for (const text of privateTexts) await expect(page.getByText(text)).toHaveCount(0);
}

test('an invalid session mid-use sends the user to sign in, says why, and returns them where they were', async ({
  page,
  context,
}) => {
  const account = newAccount();
  await signUpCustomer(page, account);
  await page.goto('/appointments');
  await expect(page.getByText('Nothing coming up')).toBeVisible();

  // Both tokens replaced by values the server cannot accept (tampered, or revoked elsewhere).
  const { origin } = new URL(page.url());
  await context.clearCookies();
  await context.addCookies([
    { name: 'appt_access', value: 'not-a-real-token', url: origin },
    { name: 'appt_refresh', value: 'forged-refresh-token', url: origin },
  ]);

  await page.getByRole('link', { name: 'Assistant' }).click();

  await expect(page).toHaveURL(/\/login\?next=%2Fassistant&expired=1$/);
  await expect(page.getByText('Your session has ended')).toBeVisible();
  await signInWithForm(page, account);
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByRole('heading', { name: 'How can I help you book?' })).toBeVisible();
});

test('a session that ends while the booking form is open keeps what was entered, and books it after signing in', async ({
  page,
  context,
}) => {
  const account = newAccount();
  const api = await signUpCustomer(page, account);
  const slot = await findOpenSlot(api, 'Teeth Whitening');
  const note = 'Sensitive teeth, please go gently.';

  await page.goto('/appointments');
  await page.getByRole('button', { name: 'New appointment' }).click();
  let dialog = page.getByRole('dialog', { name: 'New appointment' });
  await dialog.getByText('Teeth Whitening', { exact: true }).click();
  await dialog.getByLabel('Date').fill(slot.date);
  await dialog.getByRole('radio', { name: clockTime(slot.time), exact: true }).click();
  await dialog.getByLabel('Notes (optional)').fill(note);

  // The session ends (cookies expired) while the user is still on the form.
  await context.clearCookies();
  await dialog.getByRole('button', { name: 'Book appointment' }).click();

  await expect(page).toHaveURL(/\/login\?next=%2Fappointments&expired=1$/);
  await expect(page.getByText('Your session has ended')).toBeVisible();
  await signInWithForm(page, account);

  await expect(page).toHaveURL(/\/appointments$/);
  dialog = page.getByRole('dialog', { name: 'New appointment' });
  await expect(dialog.getByText('We kept your details')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Teeth Whitening/ })).toBeChecked();
  await expect(dialog.getByLabel('Date')).toHaveValue(slot.date);
  await expect(dialog.getByRole('radio', { name: clockTime(slot.time), exact: true })).toBeChecked();
  await expect(dialog.getByLabel('Notes (optional)')).toHaveValue(note);

  await dialog.getByRole('button', { name: 'Book appointment' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('article', { name: 'Teeth Whitening' })).toContainText(note);
  expect(await api.appointments()).toHaveLength(1);

  // Restored once: the next booking starts blank.
  await page.getByRole('button', { name: 'New appointment' }).click();
  await expect(dialog.getByText('We kept your details')).toHaveCount(0);
  await expect(dialog.getByLabel('Notes (optional)')).toHaveValue('');
});

test('a slow or failing session check on load (a server waking up) waits and retries instead of signing out', async ({
  page,
}) => {
  await signUpCustomer(page);
  let refreshes = 0;
  await page.route('**/api/auth/refresh', async (route) => {
    refreshes++;
    // The first attempt never gets an answer; the second is answered slowly.
    if (refreshes === 1) return route.abort('timedout');
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    return route.continue();
  });

  await page.goto('/appointments');
  await expect(page.getByRole('status').filter({ hasText: 'Waking up the server' })).toBeVisible();
  await expect(page.getByText('Nothing coming up')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/appointments$/);
  expect(refreshes).toBe(2);
});
