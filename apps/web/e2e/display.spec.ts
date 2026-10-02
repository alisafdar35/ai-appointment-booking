import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  ApiClient,
  BLUEWAVE,
  clockTime,
  findOpenSlot,
  longDate,
  newAccount,
  shortDate,
  signInCustomer,
  signUpCustomer,
  spokenDate,
  spokenTime,
  type Account,
} from './support/api';
import { bookedCard, clickAndAwaitTurn, latestSummary, openConversation, send } from './support/chat';

/**
 * What the dashboard and the assistant show: whose appointments, at what
 * time, in what state. Times are always the business's wall clock, whatever
 * zone the browser is in.
 */

/** A browser in another timezone, otherwise the same device as the current project. */
async function pageInZone(browser: Browser, timezoneId: string): Promise<Page> {
  const { baseURL, viewport, deviceScaleFactor, isMobile, hasTouch, userAgent, locale } = test.info().project.use;
  const context = await browser.newContext({
    baseURL,
    viewport,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    userAgent,
    locale,
    timezoneId,
  });
  return context.newPage();
}

test.describe('the browser timezone does not move appointment times', () => {
  // UTC+5 and UTC-7/-8: a New York afternoon is late evening (or the next day) in Karachi and morning in Los Angeles.
  const ZONES = ['Asia/Karachi', 'America/Los_Angeles'] as const;

  test('a booking made in one zone reads the same, in business time, in every zone', async ({ browser }) => {
    const account: Account = newAccount('Zara Qureshi');
    const pages: Page[] = [];
    for (const zone of ZONES) pages.push(await pageInZone(browser, zone));
    const [karachi, losAngeles] = pages as [Page, Page];

    // Sign up in Karachi and book through the dialog there.
    const api = await ApiClient.connect(karachi.request, account, { signUp: true });
    await karachi.context().addInitScript(() => window.localStorage.setItem('slotly.session', '1'));
    // The latest free time on the day: late enough to fall on the next calendar day in Karachi.
    const slot = await findOpenSlot(api, 'Routine Checkup');
    const time = slot.freeTimes[slot.freeTimes.length - 1]!;
    await karachi.goto('/appointments');
    await karachi.getByRole('button', { name: 'New appointment' }).click();
    const dialog = karachi.getByRole('dialog', { name: 'New appointment' });
    await dialog.getByText('Routine Checkup', { exact: true }).click();
    await dialog.getByLabel('Date').fill(slot.date);
    await expect(dialog.getByText(/times shown in E[SD]T/)).toBeVisible();
    await dialog.getByRole('radio', { name: clockTime(time), exact: true }).click();
    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    await expect(dialog).toBeHidden();

    // The instant saved is that wall-clock time in the business's zone.
    const [saved] = await api.appointments();
    const businessClock = new Intl.DateTimeFormat('en-US', {
      timeZone: BLUEWAVE.timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(saved!.startsAt));
    expect(businessClock).toBe(clockTime(time));

    await signInCustomer(losAngeles, account);
    const labels: string[] = [];
    for (const page of pages) {
      await page.goto('/appointments');
      const when = page.getByRole('article', { name: 'Routine Checkup' }).locator('p').first();
      await expect(when).toContainText(shortDate(slot.date));
      await expect(when).toContainText(`${clockTime(time)} – `);
      labels.push((await when.innerText()).replace(/\(.*\)/, '').trim());
    }
    // Identical labels, browser zone notwithstanding (the relative "in N days" part aside).
    expect(labels[0]).toBe(labels[1]);

    // The assistant's summary uses business time too.
    const other = await findOpenSlot(api, 'Teeth Whitening');
    await losAngeles.goto('/assistant');
    await send(losAngeles, `Teeth whitening on ${spokenDate(other.date)} at ${spokenTime(other.time)}`);
    await expect(latestSummary(losAngeles)).toContainText(longDate(other.date));
    await expect(latestSummary(losAngeles)).toContainText(new RegExp(`${clockTime(other.time)} E[SD]T`));

    for (const page of pages) await page.context().close();
  });
});

test.describe('whose appointments, and in what state', () => {
  test('a customer sees only their own bookings, with the right day, time and status', async ({ page, request }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Routine Checkup', { atLeastFree: 2 });
    await api.book({ serviceId: slot.service.id, date: slot.date, time: slot.time, notes: 'Mine' });
    // Another customer of the same business books the same day.
    const neighbour = await ApiClient.connect(request, newAccount('Theo Lindqvist'), { signUp: true });
    await neighbour.book({ serviceId: slot.service.id, date: slot.date, time: slot.freeTimes[1]!, notes: 'Not yours' });

    await page.goto('/appointments');
    await expect(page.getByText('Your upcoming and past bookings.')).toBeVisible();
    const cards = page.getByRole('article');
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('Mine');
    await expect(cards).toContainText(shortDate(slot.date));
    await expect(cards).toContainText(`${clockTime(slot.time)} – `);
    await expect(cards).toContainText('Confirmed');
    await expect(page.getByText('Not yours')).toHaveCount(0);
    await expect(page.getByText('Theo Lindqvist')).toHaveCount(0);
  });

  test('a cancellation shows everywhere the booking appears; rescheduling is not offered', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Emergency Consult');

    await page.goto('/assistant');
    await send(page, `Emergency consult on ${spokenDate(slot.date)} at ${spokenTime(slot.time)}`);
    await clickAndAwaitTurn(page, latestSummary(page).getByRole('button', { name: 'Confirm booking' }));
    await expect(bookedCard(page)).toContainText('Confirmed');

    await bookedCard(page).getByRole('link', { name: 'View in appointments' }).click();
    const card = page.getByRole('article', { name: 'Emergency Consult' });
    // Cancel is the only change on offer: there is no reschedule action.
    await expect(card.getByRole('button')).toHaveText([/Cancel/]);
    await card.getByRole('button', { name: /^Cancel Emergency Consult/ }).click();
    await page.getByRole('dialog', { name: 'Cancel this appointment?' }).getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.getByRole('tab', { name: /^Upcoming\s*0$/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Cancelled\s*1$/ })).toBeVisible();

    // Back in the assistant, the conversation's receipt no longer vouches for the booking: the
    // transcript only carries bookings still going ahead, so it shows what was booked and points
    // to the dashboard for the status, instead of a stale "Confirmed".
    await page.getByRole('link', { name: 'Assistant' }).click();
    // A finished conversation is listed under what it booked.
    await openConversation(page, /Booked Emergency Consult/);
    await expect(bookedCard(page)).toContainText('Its current status is on your appointments page.');
    await expect(bookedCard(page)).not.toContainText('Confirmed');

    // After a reload the receipt no longer claims a status it cannot vouch for.
    await page.reload();
    await openConversation(page, /Booked Emergency Consult/);
    await expect(bookedCard(page)).toBeVisible();
    await expect(bookedCard(page)).not.toContainText('Confirmed');
    expect((await api.appointments()).map((appointment) => appointment.status)).toEqual(['cancelled']);
  });
});
