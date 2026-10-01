import { defineConfig } from '@playwright/test';

import { DEVICE } from './src/device';

import { BASE_URL, REUSE } from './src/stack-file';

/**
 * Storefront end-to-end suite: the mini-program's "模拟小程序" H5 build
 * (`apps/mini`, `build:h5:mp-emulation`) in a mobile browser, with the fake
 * `api.weixin.qq.com` answering `wx.login` / `getPhoneNumber` and the fake
 * WeChat Pay gateway answering `requestPayment` (docs/mini/spikes/S4-e2e.md).
 *
 * One command, from the repository root:
 *
 *     pnpm --filter @shop/e2e-storefront test
 *
 * `webServer` is `scripts/serve.ts`, mirroring `@shop/e2e-admin`'s: the whole
 * stack — Postgres, Redis, the fakes and their control-plane bridge, the seed,
 * the H5 build, `next start` and the worker — comes up inside one script so
 * `SIGINT` tears all of it down together, and so the containers exist before
 * Playwright's own `globalSetup` would have run.
 *
 * `workers: 1`, for the same reason as the admin suite: every journey shares
 * one database and one Redis, so a group-buy team one spec opens must still
 * be there when the next spec's process reads it. The suite proves the
 * journeys work end to end, not that they can be run concurrently.
 */
export default defineConfig({
  testDir: './specs-mini',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A cold `next start` plus the fake gateway plus the worker booting is
  // slower than the admin suite's single Next server.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
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
      // A phone. The emulation build does not look at the UA: it says
      // `wechat-mini` because it was built to.
      name: 'mini-h5',
      use: { ...DEVICE },
    },
  ],
  webServer: {
    command: 'pnpm exec tsx scripts/serve.ts',
    url: `${BASE_URL}/api/v1/health`,
    // Containers pull on a cold machine, `next build` runs once, and the H5
    // bundle builds once too when it is stale.
    timeout: 900_000,
    // Opt-in only (`SHOP_E2E_REUSE=1`): reusing by default let one worktree's
    // run silently drive another worktree's stack. See `src/stack-file.ts`.
    reuseExistingServer: REUSE,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
