import { defineConfig, devices } from '@playwright/test';

/**
 * The suite runs against a stack built and booted for it, from the repo root:
 *
 *   npm run e2e                        reset DB, build, boot, test, tear down
 *   npm run e2e -- --project=mobile    extra arguments reach Playwright
 *
 * scripts/e2e.mjs recreates the `appt_e2e` database (migrated with the real
 * runner, then seeded), starts the API on :4100 and the production web build
 * on :3100, runs this config with E2E_BASE_URL pointing there, and stops both
 * servers however the run ends. There is no `webServer` block: one script owns
 * the whole stack, so a failing server start is reported as such rather than
 * as a failing test.
 *
 * - No Mistral key: every assistant reply comes from the deterministic guided
 *   engine, so a message is always read the same way. The preflight
 *   (e2e/support/preflight.ts) refuses any stack with a model configured.
 * - Rate limits off: the specs sign in, refresh and chat far faster than a
 *   person, all from one IP, and would trip the per-IP refresh budget.
 * - Data: a fresh database per run. Specs sign up their own customers and
 *   book on their worker's own days (laneDays in e2e/support/api.ts), so
 *   parallel tests never compete for a slot.
 *
 * `npm run e2e:run` runs only Playwright, against E2E_BASE_URL (default
 * http://localhost:3000): for debugging against a stack started by hand, which
 * then has to meet the same conditions.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/support/preflight.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    // Dates and times are asserted as the app prints them in en-US.
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
