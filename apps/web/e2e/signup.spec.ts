import { expect, test, type Page } from '@playwright/test';
import { BLUEWAVE, newAccount } from './support/api';
import { SEEDED_PASSWORD, SEEDED_USERS } from './support/session';

/** The sign-up and sign-in forms themselves, driven as a visitor would. */

/** The account menu names the business and the role at every screen size. */
async function expectAccount(page: Page, fullName: string, business: string, role: string) {
  await page.getByRole('button', { name: new RegExp(fullName) }).click();
  await expect(page.getByText(business, { exact: true }).last()).toBeVisible();
  await expect(page.getByText(role, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
}

test.describe('signing up', () => {
  test('creates a new business and makes the signer its owner', async ({ page }) => {
    const account = newAccount('Noah Patel');
    await page.goto('/');
    await page.getByRole('link', { name: 'Get started' }).first().click();
    await expect(page).toHaveURL(/\/signup$/);

    await page.getByLabel('Full name').fill(account.fullName);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel(/^Password/).first().fill(account.password);
    await expect(page.getByRole('status').filter({ hasText: 'All password requirements met' })).toBeAttached();
    // Joining is the default; creating a business is one click away.
    await expect(page.getByRole('radio', { name: 'Join an existing business' })).toBeChecked();
    await page.getByText('Create a new business').click();
    await page.getByLabel('Business name').fill('Harborview Physio');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/assistant$/);
    await expectAccount(page, account.fullName, 'Harborview Physio', 'Owner');
    // Owners see the whole business on the dashboard, not just their own bookings.
    await page.getByRole('link', { name: 'Appointments' }).click();
    await expect(page.getByText('Every booking at Harborview Physio, with the customer it belongs to.')).toBeVisible();
  });

  test('joins an existing business by its code', async ({ page }) => {
    const account = newAccount('Elena Torres');
    await page.goto('/signup');

    await page.getByLabel('Full name').fill(account.fullName);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel(/^Password/).first().fill(account.password);
    await page.getByText('Join an existing business').click();
    await page.getByLabel('Business code').fill(BLUEWAVE.slug);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/assistant$/);
    await expect(page.getByRole('heading', { name: 'How can I help you book?' })).toBeVisible();
    await expectAccount(page, account.fullName, BLUEWAVE.name, 'Customer');
  });

  test('reports an unknown business code without losing what was typed', async ({ page }) => {
    const account = newAccount();
    await page.goto('/signup');

    await page.getByLabel('Full name').fill(account.fullName);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel(/^Password/).first().fill(account.password);
    await page.getByText('Join an existing business').click();
    await page.getByLabel('Business code').fill('no-such-business-e2e');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByLabel('Email')).toHaveValue(account.email);
    await expect(page.getByRole('alert').first()).toBeVisible();
  });
});

test('signing in returns the visitor to the page they were sent away from', async ({ page }) => {
  await page.goto('/appointments');
  await expect(page).toHaveURL(/\/login\?next=%2Fappointments$/);

  await page.getByLabel('Email').fill(SEEDED_USERS.owner.email);
  await page.getByLabel(/^Password/).first().fill(SEEDED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/appointments$/);
  await expect(page.getByRole('button', { name: new RegExp(SEEDED_USERS.owner.fullName) })).toBeVisible();
});
