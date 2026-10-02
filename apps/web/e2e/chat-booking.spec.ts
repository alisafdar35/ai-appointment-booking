import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  ApiClient,
  BLUEWAVE,
  clockTime,
  findOpenSlot,
  longDate,
  newAccount,
  otherFreeTime,
  signUpCustomer,
  spokenDate,
  spokenTime,
} from './support/api';
import {
  bookedCard,
  clickAndAwaitTurn,
  latestSummary,
  openConversation,
  send,
  startNewConversation,
  transcript,
} from './support/chat';

/**
 * Booking by conversation, end to end against the real API.
 *
 * Determinism: the stack runs without a Mistral key (the preflight enforces
 * it), so every reply comes from the rule-based guided engine; each test signs
 * up its own customer; and every date is a free slot read from the live
 * availability endpoint, on this worker's own business days (laneDays in
 * support/api.ts), in the business's timezone.
 */

test.describe('booking by conversation', () => {
  test('collects the details, takes a correction, books, and puts it on the dashboard', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Routine Checkup', { atLeastFree: 2 });
    const corrected = otherFreeTime(slot);

    await page.goto('/assistant');

    await send(page, "Hi, I'd like a routine checkup");
    await expect(transcript(page).getByText(/Routine Checkup\. What day and time would suit you\?/)).toBeVisible();

    await send(page, `${spokenDate(slot.date)} at ${spokenTime(slot.time)} please`);
    await expect(latestSummary(page)).toContainText(longDate(slot.date));
    await expect(latestSummary(page)).toContainText(clockTime(slot.time));

    await send(page, `actually ${spokenTime(corrected)}`);
    await expect(latestSummary(page)).toContainText(clockTime(corrected));
    // The earlier summary stays as history and can no longer be confirmed.
    await expect(page.getByRole('button', { name: 'Confirm booking' }).first()).toBeDisabled();

    await clickAndAwaitTurn(page, latestSummary(page).getByRole('button', { name: 'Confirm booking' }));
    await expect(bookedCard(page)).toContainText(`${clockTime(corrected)} – `);
    await expect(page.getByRole('button', { name: 'New conversation' }).last()).toBeVisible();

    const download = page.waitForEvent('download');
    await bookedCard(page).getByRole('button', { name: 'Add to calendar' }).click();
    const calendarFile = await download;
    expect(calendarFile.suggestedFilename()).toBe(`slotly-routine-checkup-${slot.date}.ics`);
    const ics = await readFile(await calendarFile.path(), 'utf8');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain(`SUMMARY:Routine Checkup at ${BLUEWAVE.name}`);

    await bookedCard(page).getByRole('link', { name: 'View in appointments' }).click();
    await expect(page).toHaveURL(/\/appointments$/);
    const card = page.getByRole('article', { name: 'Routine Checkup' });
    await expect(card).toContainText(`${clockTime(corrected)} – `);
    await expect(card).toContainText('Chat');
  });

  test('offers other times when the slot is taken before confirming, and books the one picked', async ({
    page,
    request,
  }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Teeth Whitening');

    await page.goto('/assistant');
    await send(page, `Teeth whitening on ${spokenDate(slot.date)} at ${spokenTime(slot.time)}`);
    await expect(latestSummary(page)).toContainText(clockTime(slot.time));

    // Someone else books that exact slot while the summary is on screen.
    const rival = await ApiClient.connect(request, newAccount('Jordan Blake'), { signUp: true });
    await rival.book({ serviceId: slot.service.id, date: slot.date, time: slot.time });

    await clickAndAwaitTurn(page, latestSummary(page).getByRole('button', { name: 'Confirm booking' }));
    const suggestions = page.getByRole('group', { name: 'Suggested replies' }).getByRole('button');
    await expect(suggestions.first()).toBeVisible();
    const picked = (await suggestions.first().textContent())!.trim();

    await clickAndAwaitTurn(page, suggestions.first());
    await expect(latestSummary(page)).toContainText(picked);

    await clickAndAwaitTurn(page, latestSummary(page).getByRole('button', { name: 'Confirm booking' }));
    await expect(bookedCard(page)).toContainText(`${picked} – `);
  });

  test('keeps the conversation and its live summary across a reload and a switch of conversation', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Orthodontic Review');
    const request = `Orthodontic review on ${spokenDate(slot.date)} at ${spokenTime(slot.time)}`;

    await page.goto('/assistant');
    await send(page, request);
    await expect(latestSummary(page)).toContainText(clockTime(slot.time));

    await page.reload();
    await expect(transcript(page).getByText(request)).toBeVisible();
    await expect(latestSummary(page).getByRole('button', { name: 'Confirm booking' })).toBeEnabled();

    await startNewConversation(page);
    await expect(transcript(page)).toBeHidden();

    await openConversation(page, new RegExp(request.slice(0, 20)));
    await expect(latestSummary(page)).toContainText(longDate(slot.date));
    await clickAndAwaitTurn(page, latestSummary(page).getByRole('button', { name: 'Confirm booking' }));
    await expect(bookedCard(page)).toContainText('Orthodontic Review');
  });
});

test.describe('the structured form', () => {
  test('books without typing a sentence when the user prefers a form', async ({ page }) => {
    const api = await signUpCustomer(page);
    const slot = await findOpenSlot(api, 'Emergency Consult');

    await page.goto('/assistant');
    await page.getByRole('button', { name: 'Prefer a form?' }).click();

    const form = page.locator('#booking-form');
    await expect(form.getByRole('heading', { name: 'Book with a quick form' })).toBeVisible();
    await form.getByLabel('Service').selectOption(slot.service.name);
    await form.getByLabel('Date').fill(slot.date);
    await form.getByRole('radio', { name: clockTime(slot.time), exact: true }).click();
    await form.getByLabel('Notes').fill('Sharp pain on the lower left since yesterday.');
    await clickAndAwaitTurn(page, form.getByRole('button', { name: 'Book appointment' }));

    // The submission reads as the user's own turn, then the receipt.
    await expect(
      transcript(page).getByText(`Book Emergency Consult on ${longDate(slot.date)} at ${clockTime(slot.time)}.`),
    ).toBeVisible();
    await expect(bookedCard(page)).toContainText('Sharp pain on the lower left since yesterday.');
    await expect(form).toBeHidden();
  });

  test('is offered, prefilled, when the conversation is not getting anywhere', async ({ page }) => {
    await signUpCustomer(page);
    await page.goto('/assistant');

    for (const text of ['hello', 'hmm', 'not sure', 'let me think']) await send(page, text);

    await expect(transcript(page).getByText(/you can fill in the booking form instead/)).toBeVisible();
    await expect(page.locator('#booking-form').getByRole('heading', { name: 'Book with a quick form' })).toBeVisible();
    await expect(page.locator('#booking-form').getByLabel('Service')).toHaveValue('');
  });
});
