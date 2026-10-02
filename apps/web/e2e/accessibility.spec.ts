import { expect, test, type Page } from '@playwright/test';
import { BLUEWAVE, clockTime, findOpenSlot, signUpCustomer } from './support/api';
import { send, transcript } from './support/chat';

/**
 * Using the app without a mouse, and with the page zoomed. Both are about a
 * desktop browser, so they skip the phone project (which already runs every
 * other spec at phone size).
 */

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, 'keyboard and zoom checks are for desktop browsers');
});

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** Press Tab until the focused element matches, as a keyboard user would. */
async function tabTo(page: Page, matches: (element: { text: string; type: string; name: string; role: string }) => boolean) {
  const seen: string[] = [];
  for (let presses = 0; presses < 60; presses++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLInputElement | null;
      return {
        text: (element?.getAttribute('aria-label') ?? element?.textContent ?? '').trim(),
        type: element?.type ?? '',
        name: element?.name ?? '',
        role: element?.getAttribute('role') ?? '',
      };
    });
    if (matches(focused)) return focused;
    seen.push(`${focused.role || focused.type}:${focused.text.slice(0, 20)}`);
  }
  throw new Error(`Tab never reached the element; focus went through: ${[...new Set(seen)].join(' | ')}`);
}

test('books, sees validation errors and closes dialogs with the keyboard alone', async ({ page, browserName }) => {
  // What Tab reaches, and how a date field takes typed digits, are browser and OS settings rather
  // than the app's: Firefox on macOS tabs only between text fields by default, and WebKit's date
  // field segments differ. The sequence is pinned to Chromium.
  test.skip(browserName !== 'chromium', 'keyboard sequence is pinned to Chromium');
  const api = await signUpCustomer(page);
  const slot = await findOpenSlot(api, 'Routine Checkup');
  await page.goto('/appointments');
  await expect(page.getByText('Nothing coming up')).toBeVisible();

  await tabTo(page, ({ text }) => text === 'New appointment');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New appointment' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(':focus')).toHaveCount(1);

  // Submitting empty explains every missing field, and focus stays in the dialog.
  await tabTo(page, ({ text }) => text === 'Book appointment');
  await page.keyboard.press('Enter');
  for (const message of ['Choose a service', 'Choose a date', 'Choose a time']) {
    await expect(dialog.getByText(message).first()).toBeVisible();
  }
  await expect(dialog.locator(':focus')).toHaveCount(1);

  // Service: Tab into the radio group, then arrow keys until the one wanted is chosen.
  await tabTo(page, ({ type, name }) => type === 'radio' && name === 'serviceId');
  await page.keyboard.press('Space');
  for (let step = 0; step < 6 && !(await dialog.getByRole('radio', { name: /Routine Checkup/ }).isChecked()); step++) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(dialog.getByRole('radio', { name: /Routine Checkup/ })).toBeChecked();

  // Date: typed into the native date field. Its segment order follows the browser's own
  // locale (month or day first), so if month-first did not take, go back and type day-first.
  await tabTo(page, ({ type }) => type === 'date');
  const [year, month, day] = slot.date.split('-');
  await page.keyboard.type(`${month}${day}${year}`);
  if ((await dialog.getByLabel('Date').inputValue()) !== slot.date) {
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type(`${day}${month}${year}`);
  }
  await expect(dialog.getByLabel('Date')).toHaveValue(slot.date);

  // Time: the grid is one Tab stop; arrow keys move and select. It loads after the date is set.
  await expect(dialog.getByRole('radiogroup', { name: 'Available times' })).toBeVisible();
  const firstTime = await tabTo(page, ({ role }) => role === 'radio');
  await page.keyboard.press('Space');
  const picked = firstTime.text.replace(/ \(unavailable\)$/, '');
  await expect(dialog.getByRole('radio', { name: picked, exact: true })).toBeChecked();

  await tabTo(page, ({ text }) => text === 'Book appointment');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('article', { name: 'Routine Checkup' })).toContainText(`${picked} – `);
  const [saved] = await api.appointments();
  expect(
    new Intl.DateTimeFormat('en-US', { timeZone: BLUEWAVE.timeZone, hour: 'numeric', minute: '2-digit' }).format(
      new Date(saved!.startsAt),
    ),
  ).toBe(picked);

  // Focus came back to the button that opened the dialog; Escape closes it again.
  await expect(page.getByRole('button', { name: 'New appointment' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'New appointment' })).toBeFocused();
});

test('at 200% zoom (a 1280px window shows 640 CSS pixels) everything still fits and works', async ({ page }) => {
  const api = await signUpCustomer(page);
  const slot = await findOpenSlot(api, 'Teeth Whitening');
  await page.setViewportSize({ width: 640, height: 360 });

  await page.goto('/appointments');
  await expect(page.getByRole('button', { name: 'New appointment' })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);

  await page.getByRole('button', { name: 'New appointment' }).click();
  const dialog = page.getByRole('dialog', { name: 'New appointment' });
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(640);
  await dialog.getByText('Teeth Whitening', { exact: true }).click();
  await dialog.getByLabel('Date').fill(slot.date);
  await dialog.getByRole('radio', { name: clockTime(slot.time), exact: true }).click();
  await dialog.getByRole('button', { name: 'Book appointment' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('article', { name: 'Teeth Whitening' })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);

  await page.goto('/assistant');
  await send(page, "Hi, I'd like a routine checkup");
  await expect(transcript(page).getByText(/Routine Checkup\. What day and time would suit you\?/)).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
});
