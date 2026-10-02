import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ApiClient, clockTime, findOpenSlot, newAccount, otherFreeTime, signUpCustomer } from './support/api';
import { SEEDED_USERS, signInViaApi } from './support/session';

/**
 * The appointments dashboard: the booking dialog, cancelling, and the staff
 * view. Each test has its own customer and books on its own worker's days (see
 * laneDays in support/api.ts), so they can run in parallel.
 */

test.describe('booking from the dashboard', () => {
  test('books from the dialog, and recovers when the chosen time is taken first', async ({ page, request }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Routine Checkup', { atLeastFree: 2 });
    const fallback = otherFreeTime(slot);

    await page.goto('/appointments');
    await expect(page.getByText('Nothing coming up')).toBeVisible();
    await page.getByRole('button', { name: 'New appointment' }).click();

    const dialog = page.getByRole('dialog', { name: 'New appointment' });
    // The service cards are labels for visually hidden radios: a person clicks the card.
    await dialog.getByText('Routine Checkup', { exact: true }).click();
    await expect(dialog.getByRole('radio', { name: /Routine Checkup/ })).toBeChecked();
    await dialog.getByLabel('Date').fill(slot.date);
    await dialog.getByRole('radio', { name: clockTime(slot.time), exact: true }).click();
    await dialog.getByLabel('Notes (optional)').fill('Please check the filling on the lower right.');

    const rival = await ApiClient.connect(request, newAccount('Jordan Blake'), { signUp: true });
    await rival.book({ serviceId: slot.service.id, date: slot.date, time: slot.time });

    await dialog.getByRole('button', { name: 'Book appointment' }).click();
    await expect(dialog.getByText('That time was just taken. Pick another from the times above.')).toBeVisible();
    // Availability was refetched: the lost time is now shown as taken.
    await expect(dialog.getByRole('radio', { name: `${clockTime(slot.time)} (unavailable)`, exact: true })).toBeDisabled();

    await dialog.getByRole('radio', { name: clockTime(fallback), exact: true }).click();
    await dialog.getByRole('button', { name: 'Book appointment' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Routine Checkup booked' })).toBeVisible();
    const card = page.getByRole('article', { name: 'Routine Checkup' });
    await expect(card).toContainText(`${clockTime(fallback)} – `);
    await expect(card).toContainText('Please check the filling on the lower right.');
    await expect(page.getByRole('tab', { name: /^Upcoming\s*1$/ })).toBeVisible();
  });
});

test.describe('cancelling', () => {
  test('cancels with a reason, which the Cancelled view then shows', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Teeth Whitening');
    await api.book({ serviceId: slot.service.id, date: slot.date, time: slot.time });

    await page.goto('/appointments');
    await page.getByRole('button', { name: /^Cancel Teeth Whitening on / }).click();

    const dialog = page.getByRole('dialog', { name: 'Cancel this appointment?' });
    // The safe choice holds focus, so a stray Enter keeps the booking.
    await expect(dialog.getByRole('button', { name: 'Keep appointment' })).toBeFocused();
    await dialog.getByLabel('Reason (optional)').fill('Something came up at work.');
    await dialog.getByRole('button', { name: 'Cancel appointment' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('tab', { name: /^Upcoming\s*0$/ })).toBeVisible();
    await page.getByRole('tab', { name: /^Cancelled/ }).click();
    const card = page.getByRole('article', { name: 'Teeth Whitening' });
    await expect(card).toContainText('Cancelled');
    await expect(card).toContainText('Reason for cancelling: Something came up at work.');
  });
});

test.describe('staff view', () => {
  test('shows every booking at the business with the customer it belongs to', async ({ page, request }) => {
    // A name no other booking carries, so the card is found by its customer
    // wherever it falls in the list. The database is recreated for each run,
    // which keeps the business far below the list's 100-booking page.
    const account = newAccount(`Amara Okafor ${randomUUID().slice(0, 6)}`);
    const customer = await ApiClient.connect(request, account, { signUp: true });
    const slot = await findOpenSlot(customer, 'Emergency Consult');
    await customer.book({ serviceId: slot.service.id, date: slot.date, time: slot.time });

    await signInViaApi(page, SEEDED_USERS.staff);
    await page.goto('/appointments');

    await expect(page.getByText('Every booking at Bluewave Dental, with the customer it belongs to.')).toBeVisible();
    const card = page.getByRole('article').filter({ hasText: account.fullName });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(account.email);
    await expect(card).toContainText('Emergency Consult');
    await expect(card).toContainText(`${clockTime(slot.time)} – `);
  });
});
