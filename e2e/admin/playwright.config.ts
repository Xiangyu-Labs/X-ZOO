import { defineConfig, devices } from '@playwright/test';

import { BASE_URL, REUSE } from './src/stack-file';

/**
 * Admin end-to-end suite.
 *
 * One command, from the repository root:
 *
 *     pnpm --filter @shop/e2e-admin e2e
 *
 * Playwright's `webServer` is `scripts/serve.ts` — a script that runs
 * `pnpm gen`, brings up PostgreSQL 17 and Redis 7 (Testcontainers, or an
 * already-running pair through `SHOP_TEST_PG_URL` / `SHOP_TEST_REDIS_URL`),
 * applies the schema, seeds the fixtures, builds the app if it has not been
 * built, and starts the real Next server against them.
 *
 * Why the stack is inside the `webServer` command rather than in `globalSetup`:
 * Playwright starts `webServer` *before* `globalSetup` runs, so a globalSetup
 * that created the database would create it after the server had already
 * failed to connect. Putting both in one script also means `SIGINT` kills the
 * containers and the server together.
 *
 * `workers: 1` is deliberate. Every worker would share the one database and the
 * one Redis, so parallel specs would see each other's orders, coupons and
 * audit rows. The suite is an authorisation and money check, not a load test;
 * `load` is the one that is allowed to be parallel.
 */
export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A cold `next start` compiles nothing, but the first request to a route
  // still pays for module loading, and the seeded database is not tiny.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    navigationTimeout: 60_000,
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      // Chromium only, on purpose: these specs assert authorisation, audit
      // rows and masked secrets, not browser compatibility. A second engine
      // would double the runtime and assert nothing new.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm exec tsx scripts/serve.ts',
    url: `${BASE_URL}/api/v1/health`,
    // Containers pull on a cold machine and `next build` runs once.
    timeout: 900_000,
    // Opt-in only (`SHOP_E2E_REUSE=1`): reusing by default let one worktree's
    // run silently test another worktree's server. See `src/stack-file.ts`.
    reuseExistingServer: REUSE,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
