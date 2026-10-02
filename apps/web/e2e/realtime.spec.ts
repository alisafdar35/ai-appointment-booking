import { expect, test } from '@playwright/test';
import { clockTime, findOpenSlot, signUpCustomer, spokenDate, spokenTime } from './support/api';
import { clickAndAwaitTurn, latestSummary, send } from './support/chat';

/**
 * Live updates across tabs. Both pages share one browser context (one signed-in
 * user, two tabs), and the second is never reloaded or refocused: only the
 * socket event can bring the new booking onto it.
 */
test('a booking made in one tab appears on the dashboard open in another', async ({ page, context }) => {
  const api = await signUpCustomer(page);
  const slot = await findOpenSlot(api, 'Routine Checkup');

  const dashboard = await context.newPage();
  await dashboard.goto('/appointments');
  await expect(dashboard.getByText('Nothing coming up')).toBeVisible();
  await expect(dashboard.getByTitle(/other tabs or devices/)).toContainText('Live');

  await page.goto('/assistant');
  await send(page, `Routine checkup on ${spokenDate(slot.date)} at ${spokenTime(slot.time)}`);
  await clickAndAwaitTurn(page, latestSummary(page).getByRole('button', { name: 'Confirm booking' }));

  const card = dashboard.getByRole('article', { name: 'Routine Checkup' });
  await expect(card).toContainText(`${clockTime(slot.time)} – `);
  await expect(dashboard.getByRole('tab', { name: /^Upcoming\s*1$/ })).toBeVisible();
});
