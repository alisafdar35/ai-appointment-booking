import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { clockTime, findOpenSlot, longDate, signUpCustomer, spokenDate, spokenTime } from './support/api';
import {
  bookedCard,
  clickAndAwaitTurn,
  latestSummary,
  messageBox,
  openConversation,
  send,
  startNewConversation,
  transcript,
} from './support/chat';

/**
 * What happens when the network, the API or the user does something awkward:
 * slow answers and double clicks, a reload at the worst moment, a dropped
 * connection, a dead socket, two tabs, and a switch of conversation while a
 * reply is still on its way. Faults are injected with route interception, so
 * the real stack still does the work.
 */

const SLOW_MS = 1_500;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isPath = (path: string) => (url: URL) => url.pathname === path;
const isBookingPost = (request: Request) =>
  request.method() === 'POST' && new URL(request.url()).pathname === '/api/appointments';

async function openDialogWithSlot(page: Page, slot: { service: { name: string }; date: string; time: string }) {
  await page.getByRole('button', { name: 'New appointment' }).click();
  const dialog = page.getByRole('dialog', { name: 'New appointment' });
  await dialog.getByText(slot.service.name, { exact: true }).click();
  await dialog.getByLabel('Date').fill(slot.date);
  await dialog.getByRole('radio', { name: clockTime(slot.time), exact: true }).click();
  return dialog;
}

test.describe('slow API and impatient clicks', () => {
  test('a double click on Book appointment shows it is working and sends one request, with an idempotency key', async ({
    page,
  }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Routine Checkup');
    const keys: (string | undefined)[] = [];
    await page.route(isPath('/api/appointments'), async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      await delay(SLOW_MS);
      await route.continue();
    });

    await page.goto('/appointments');
    const dialog = await openDialogWithSlot(page, slot);
    const book = dialog.getByRole('button', { name: 'Book appointment' });
    await book.dblclick();

    await expect(book).toHaveAttribute('aria-busy', 'true');
    await expect(book).toBeDisabled();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await api.appointments()).toHaveLength(1);
    await expect(page.getByRole('article', { name: 'Routine Checkup' })).toHaveCount(1);
  });

  test('a booking whose response is lost is retried with the same key and is not made twice', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Routine Checkup');
    const keys: (string | undefined)[] = [];
    await page.route(isPath('/api/appointments'), async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      if (keys.length === 1) {
        // The server books it, but the answer never reaches the browser.
        await route.fetch();
        return route.abort('connectionreset');
      }
      return route.continue();
    });

    await page.goto('/appointments');
    const dialog = await openDialogWithSlot(page, slot);
    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    await expect(dialog.getByText("We couldn't reach the server. Check your connection and try again.")).toBeVisible();

    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    await expect(dialog).toBeHidden();

    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(await api.appointments()).toHaveLength(1);
    await expect(page.getByRole('article', { name: 'Routine Checkup' })).toHaveCount(1);
  });

  test('a double click on Confirm booking in chat books once', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Teeth Whitening');
    let confirmations = 0;
    await page.route(isPath('/api/chat/messages'), async (route) => {
      if ((route.request().postDataJSON() as { content?: string }).content === 'Yes, book it') {
        confirmations++;
        await delay(SLOW_MS);
      }
      await route.continue();
    });

    await page.goto('/assistant');
    await send(page, `Teeth whitening on ${spokenDate(slot.date)} at ${spokenTime(slot.time)}`);
    const confirm = latestSummary(page).getByRole('button', { name: 'Confirm booking' });
    await confirm.dblclick();

    // While the slow reply is pending: the card is no longer actionable and the assistant is "typing".
    await expect(confirm).toBeDisabled();
    await expect(page.getByRole('status').filter({ hasText: 'The assistant is typing' })).toBeAttached();
    await expect(bookedCard(page)).toBeVisible({ timeout: 10_000 });
    expect(confirmations).toBe(1);
    expect(await api.appointments()).toHaveLength(1);
    await expect(transcript(page).getByText('Yes, book it')).toHaveCount(1);
  });
});

test.describe('reloading straight after a booking', () => {
  test('in chat: the receipt and the appointment are there after an immediate reload', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Orthodontic Review');

    await page.goto('/assistant');
    await send(page, `Orthodontic review on ${spokenDate(slot.date)} at ${spokenTime(slot.time)}`);
    await clickAndAwaitTurn(page, latestSummary(page).getByRole('button', { name: 'Confirm booking' }));
    await page.reload();

    // The finished conversation is no longer the one resumed; it is in the list.
    await openConversation(page, /Booked Orthodontic Review/);
    await expect(bookedCard(page)).toContainText(longDate(slot.date));
    await expect(bookedCard(page)).toContainText(`${clockTime(slot.time)} – `);
    await page.goto('/appointments');
    await expect(page.getByRole('article', { name: 'Orthodontic Review' })).toContainText(`${clockTime(slot.time)} – `);
  });

  test('from the dialog: the appointment is listed after an immediate reload', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Emergency Consult');

    await page.goto('/appointments');
    const dialog = await openDialogWithSlot(page, slot);
    const created = page.waitForResponse((response) => isBookingPost(response.request()));
    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    await created;
    await page.reload();

    await expect(page.getByRole('article', { name: 'Emergency Consult' })).toContainText(`${clockTime(slot.time)} – `);
    await expect(page.getByRole('tab', { name: /^Upcoming\s*1$/ })).toBeVisible();
  });
});

test.describe('connection trouble', () => {
  test('a message sent while offline is kept, says why it waits, and goes out once the connection is back', async ({
    page,
    context,
  }) => {
    await signUpCustomer(page);
    await page.goto('/assistant');
    await messageBox(page).fill('I need an emergency consult');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();

    await context.setOffline(true);
    await messageBox(page).press('Enter');

    // The browser knows it is offline, so the send is held (not failed) and the page says so.
    await expect(page.getByText(/You.re offline/)).toBeVisible();
    await expect(transcript(page).getByText('I need an emergency consult')).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(transcript(page).getByText(/What day and time would suit you/)).toHaveCount(0);

    await context.setOffline(false);
    await expect(transcript(page).getByText(/Emergency Consult\. What day and time would suit you\?/)).toBeVisible();
    await expect(transcript(page).getByText('I need an emergency consult')).toHaveCount(1);
    await expect(page.getByText(/You.re offline/)).toBeHidden();
  });

  test('a message whose request drops mid-flight is kept, and Retry sends it once', async ({ page }) => {
    await signUpCustomer(page);
    await page.goto('/assistant');
    const chatMessages = isPath('/api/chat/messages');
    await page.route(chatMessages, (route) => route.abort('connectionreset'));
    await messageBox(page).fill('I need an emergency consult');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await messageBox(page).press('Enter');

    const failure = page.getByRole('alert').filter({ hasText: "Couldn't reach the server" });
    await expect(failure).toBeVisible();
    await expect(transcript(page).getByText('I need an emergency consult')).toBeVisible();

    await page.unroute(chatMessages);
    await failure.getByRole('button', { name: 'Retry' }).click();
    await expect(failure).toBeHidden();
    await expect(transcript(page).getByText(/Emergency Consult\. What day and time would suit you\?/)).toBeVisible();
    await expect(transcript(page).getByText('I need an emergency consult')).toHaveCount(1);
  });

  test('with live updates down, everything keeps working without repeated error messages', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Routine Checkup');
    await page.routeWebSocket(/socket\.io/, (socket) => socket.close());
    await page.route(/socket\.io/, (route) => route.abort());

    await page.goto('/assistant');
    await expect(page.getByTitle(/keep retrying/)).toBeVisible({ timeout: 15_000 });
    await send(page, "Hi, I'd like a routine checkup");
    await expect(transcript(page).getByText(/Routine Checkup\. What day and time would suit you\?/)).toBeVisible();

    await page.getByRole('link', { name: 'Appointments' }).click();
    const dialog = await openDialogWithSlot(page, slot);
    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    await expect(dialog).toBeHidden();

    // Several reconnect attempts later, the page is still calm and still shows its content.
    await page.waitForTimeout(12_000);
    // (Next.js's route announcer is also role="alert"; it only reads out the page title.)
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
    await expect(page.getByRole('article', { name: 'Routine Checkup' })).toBeVisible();
    await expect(page.getByTitle(/keep retrying/)).toHaveCount(1);
  });

  test('with the assistant unavailable, the form still books', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Emergency Consult');
    await page.route(isPath('/api/chat/messages'), (route: Route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: 'The assistant is unavailable right now.' } }),
      }),
    );

    await page.goto('/assistant');
    await messageBox(page).fill('Emergency consult please');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await messageBox(page).press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'The assistant is unavailable right now.' })).toBeVisible();

    await page.getByRole('button', { name: 'Prefer a form?' }).click();
    const form = page.locator('#booking-form');
    await form.getByLabel('Service').selectOption(slot.service.name);
    await form.getByLabel('Date').fill(slot.date);
    await form.getByRole('radio', { name: clockTime(slot.time), exact: true }).click();
    await clickAndAwaitTurn(page, form.getByRole('button', { name: 'Book appointment' }));

    await expect(bookedCard(page)).toContainText(`${clockTime(slot.time)} – `);
    expect(await api.appointments()).toHaveLength(1);
  });
});

test.describe('more than one place at once', () => {
  test('two tabs on one conversation stay in step: each message once, one booking', async ({ page, context }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Routine Checkup');
    const when = `${spokenDate(slot.date)} at ${spokenTime(slot.time)}`;

    await page.goto('/assistant');
    await send(page, "Hi, I'd like a routine checkup");
    const other = await context.newPage();
    await other.goto('/assistant');
    await expect(transcript(other).getByText("Hi, I'd like a routine checkup")).toBeVisible();
    await expect(other.getByTitle(/other tabs or devices/)).toContainText('Live');

    await send(page, when);
    // The second tab receives the turn live, without a reload, exactly once.
    await expect(latestSummary(other)).toContainText(clockTime(slot.time));
    await expect(transcript(other).getByText(when)).toHaveCount(1);
    await expect(transcript(page).getByText(when)).toHaveCount(1);

    await clickAndAwaitTurn(other, latestSummary(other).getByRole('button', { name: 'Confirm booking' }));
    await expect(bookedCard(other)).toHaveCount(1);
    await expect(bookedCard(page)).toHaveCount(1);
    // The first tab learnt the conversation is finished: it cannot book again from it.
    await expect(page.getByText('This booking is complete. Start a new conversation to book another.')).toBeVisible();
    expect(await api.appointments()).toHaveLength(1);
  });

  test('a reply that arrives after switching conversations lands in the conversation it belongs to', async ({ page }) => {
    await signUpCustomer(page);
    await page.goto('/assistant');
    await send(page, 'hello');

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(isPath('/api/chat/messages'), async (route) => {
      await held;
      await route.continue();
    });
    await messageBox(page).fill('Teeth whitening please');
    await messageBox(page).press('Enter');
    await expect(transcript(page).getByText('Teeth whitening please')).toBeVisible();

    await startNewConversation(page);
    const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/chat/messages');
    release();
    await answered;

    // The new conversation stays empty and independent: no reply, no summary.
    await expect(page.getByRole('heading', { name: 'How can I help you book?' })).toBeVisible();
    await expect(page.getByText(/Teeth Whitening\. What day and time/)).toHaveCount(0);

    await openConversation(page, /hello/);
    await expect(transcript(page).getByText(/Teeth Whitening\. What day and time would suit you\?/)).toHaveCount(1);
  });
});
