import { defineConfig, devices } from '@playwright/test';

/**
 * No `webServer` block on purpose: the suite runs against an already-running
 * stack so a failing test never hides a failing server start. Point
 * E2E_BASE_URL elsewhere to test a deployment.
 *
 * The stack under test:
 *
 *   MISTRAL_API_KEY= RATE_LIMIT_DISABLED=true npm run dev:api
 *   npm run build:web && npm run start -w @appt/web
 *   npm run e2e                     (from the repo root)
 *
 * - No Mistral key: every assistant reply then comes from the deterministic
 *   guided engine, so a message is always read the same way. The preflight
 *   (e2e/support/preflight.ts) refuses to run otherwise.
 * - Rate limits off: the specs sign in, refresh and chat far faster than a
 *   person, all from one IP, and would trip the per-IP refresh budget.
 * - Data: specs sign up their own customers and book free slots read from the
 *   live availability endpoint, so they run in parallel against a used
 *   development database (`npm run db:seed` provides the Bluewave tenant).
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
