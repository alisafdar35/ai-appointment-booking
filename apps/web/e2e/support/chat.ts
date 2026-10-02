import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Chat helpers that work at every breakpoint. On wide screens the conversation
 * list is a sidebar; on narrow ones it sits behind a "Conversations" button.
 */

export const messageBox = (page: Page) => page.getByRole('textbox', { name: 'Message' });

/** The message list alone: a conversation's title repeats its first message. */
export const transcript = (page: Page) => page.getByRole('log', { name: 'Conversation' });

/** The newest confirmation card: earlier ones stay in the transcript, disabled. */
export const latestSummary = (page: Page) => page.getByRole('region', { name: 'Booking summary' }).last();

export const bookedCard = (page: Page) => page.getByRole('region', { name: 'Booked appointment' });

const isChatTurn = (url: string) => /\/api\/chat\/(messages|draft)$/.test(new URL(url).pathname);

/**
 * Send a message and wait for the server to answer the turn. Waits for Send to
 * be enabled first: on a fresh page the composer accepts typing before the
 * conversation to send into is known, and holds the message until it is.
 */
export async function send(page: Page, text: string): Promise<void> {
  await messageBox(page).fill(text);
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  const answered = page.waitForResponse((response) => isChatTurn(response.url()));
  await messageBox(page).press('Enter');
  await answered;
}

/** Click something that sends a turn (Confirm, a suggested time) and wait for the answer. */
export async function clickAndAwaitTurn(page: Page, target: Locator): Promise<void> {
  const answered = page.waitForResponse((response) => isChatTurn(response.url()));
  await target.click();
  await answered;
}

async function conversationList(page: Page): Promise<Locator> {
  const sidebar = page.getByRole('complementary', { name: 'Conversations' });
  if (await sidebar.isVisible()) return sidebar;
  await page.getByRole('button', { name: 'Conversations' }).click();
  return page.getByRole('dialog', { name: 'Conversations' });
}

export async function startNewConversation(page: Page): Promise<void> {
  await (await conversationList(page)).getByRole('button', { name: 'New conversation' }).click();
  await expect(page.getByRole('heading', { name: 'How can I help you book?' })).toBeVisible();
}

export async function openConversation(page: Page, title: string | RegExp): Promise<void> {
  await (await conversationList(page)).getByRole('button', { name: title }).click();
}
