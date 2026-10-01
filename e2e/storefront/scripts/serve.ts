/**
 * The whole stack, in one process, for `playwright.config.ts`'s `webServer`.
 *
 *   1. PostgreSQL 17 + Redis 7 (Testcontainers), through `@shop/testing`'s own
 *      global setup — the same code the integration suite uses;
 *   2. a database cloned from that template;
 *   3. the fake `api.weixin.qq.com` the server's mini-program sign-in calls,
 *      the fake WeChat Pay gateway and the control-plane bridge to both
 *      (`src/gateway-control.ts`) — before the seed, because the seed writes
 *      `paymentConfig` and `wechatConfig` pointed at them;
 *   4. the seed (`src/seed.ts`);
 *   5. the mini-program's "模拟小程序" H5 build, if it is stale (`src/h5.ts`);
 *   6. `next build`, if `web` has not been built yet, then `next start`;
 *   7. the worker (`tsx src/main.ts` in `apps/worker`) — journeys 2–4 need a
 *      real job actually processed, unlike the admin suite, which never runs
 *      one;
 *   8. the edge (`src/edge.ts`), which is what the browser actually opens;
 *   9. the handoff file the specs read.
 *
 * Run it directly to keep a stack warm between Playwright runs, and opt the
 * runs into attaching to it:
 *
 *     pnpm --filter @shop/e2e-storefront exec tsx scripts/serve.ts
 *     SHOP_E2E_REUSE=1 pnpm --filter @shop/e2e-storefront test
 *
 * The three ports and the handoff file default to values derived from this
 * checkout's path (`src/stack-file.ts`), so a warm stack in one worktree is
 * invisible to the suite in another.
 *
 * Nothing here talks to a real WeChat, SMS or Aliyun endpoint. The fakes are
 * the only thing `paymentConfig`/`wechatConfig` ever point at.
 *
 * `SHOP_E2E_WECHAT_DEVICE=1` (never in the suite) turns on the fake WeChat's
 * fake's device mode, so a real phone's `wx.login()` code signs in against
 * the fakes (docs/mini/device-check.md, backend B).
 * `SHOP_E2E_WECHAT_DEVICE_OPENID` / `SHOP_E2E_WECHAT_DEVICE_PHONE` pin the
 * shopper, so every cold start is the same account.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateFakeWechatKeys, startFakeWechatGateway } from '@shop/testing';
import { startFakeOaServer, type FakeDeviceMode } from '@shop/testing/wechat';
import pg from 'pg';

import { startEdge } from '../src/edge';
import { startGatewayControl } from '../src/gateway-control';
import { ensureH5Build, H5_DIST_DIR } from '../src/h5';
import { seedE2E } from '../src/seed';
import {
  BASE_URL,
  EDGE_PORT,
  GATEWAY_PORT,
  STACK_FILE,
  WEB_PORT,
  WEB_URL,
  type StackInfo,
} from '../src/stack-file';

const HERE = import.meta.dirname;
const NEXT_ROOT = path.resolve(HERE, '../../..');
const WEB_DIR = path.join(NEXT_ROOT, 'apps/web');
const WORKER_DIR = path.join(NEXT_ROOT, 'apps/worker');
const E2E_DATABASE = process.env.SHOP_E2E_DATABASE ?? 'shop_e2e_storefront';

const children: ChildProcess[] = [];
let stopTemplate: (() => Promise<void>) | undefined;
let closeEdge: (() => Promise<void>) | undefined;
let closeGatewayControl: (() => Promise<void>) | undefined;
let closeGateway: (() => Promise<void>) | undefined;
let closeWechat: (() => Promise<void>) | undefined;

/** `SHOP_E2E_WECHAT_DEVICE=1` → the fake's device mode; anything else leaves it off. */
function deviceModeFromEnv(): FakeDeviceMode {
  if (process.env.SHOP_E2E_WECHAT_DEVICE !== '1') return false;
  const openid = process.env.SHOP_E2E_WECHAT_DEVICE_OPENID?.trim() || undefined;
  const phone = process.env.SHOP_E2E_WECHAT_DEVICE_PHONE?.trim() || undefined;
  return openid || phone ? { openid, phone } : true;
}

function log(line: string): void {
  console.log(`[e2e] ${line}`);
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    );
  });
}

/** Spawned to stay running (`next start`, the worker) rather than to finish. */
function spawnLong(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code) => {
    console.error(`[e2e] ${name} exited with ${code}`);
    void shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

/** `CREATE DATABASE … TEMPLATE …` — a file copy inside PostgreSQL, tens of ms. */
async function cloneTemplate(adminUrl: string, template: string): Promise<string> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [E2E_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${E2E_DATABASE}`);
    await admin.query(`CREATE DATABASE ${E2E_DATABASE} TEMPLATE ${template}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${E2E_DATABASE}`;
  return url.toString();
}

async function main(): Promise<void> {
  const started = Date.now();

  log('pnpm gen …');
  await run('pnpm', ['--workspace-root', 'run', 'gen'], NEXT_ROOT);

  const harness = await import('@shop/testing/global-setup');
  await harness.setup();
  stopTemplate = harness.teardown;

  const pgAdminUrl = process.env.SHOP_TEST_PG_URL!;
  const redisUrl = process.env.SHOP_TEST_REDIS_URL!;
  const databaseUrl = await cloneTemplate(
    pgAdminUrl,
    process.env.SHOP_TEST_TEMPLATE ?? 'shop_template',
  );

  const uploadsDir = await mkdtemp(path.join(tmpdir(), 'shop-e2e-storefront-uploads-'));

  // The mini-program signs in through the fake `api.weixin.qq.com`, and pays
  // with the mini-program's app id: WeChat Pay charges a `wechat_mini` payment
  // to the mini app, and the fake gateway refuses any other appid.
  log('starting fake api.weixin.qq.com …');
  const wechat = await startFakeOaServer({ deviceMode: deviceModeFromEnv() });
  if (wechat.deviceMode !== false) {
    log('fake api.weixin.qq.com in DEVICE MODE: any well-formed wx.login() code signs in');
  }
  closeWechat = wechat.close;

  log('starting fake WeChat Pay gateway …');
  const gateway = await startFakeWechatGateway({
    port: GATEWAY_PORT,
    keys: { ...generateFakeWechatKeys(), appId: wechat.miniAppId },
  });
  closeGateway = gateway.close;
  // The gateway settles a refund synchronously once approved, so the refund
  // journey never has to wait on `reconcileStaleRefunds()`'s sweep interval —
  // a real gateway reports PROCESSING first, but nothing here tests that wait.
  gateway.behaviour.refundStatus = 'SUCCESS';

  const control = await startGatewayControl({ gateway, baseUrl: BASE_URL, wechat });
  closeGatewayControl = control.close;

  log('seeding …');
  const seeded = await seedE2E({
    databaseUrl,
    redisUrl,
    uploadsDir,
    gateway,
    gatewayApiUrl: gateway.url,
    baseUrl: BASE_URL,
    miniProgram: { appSecret: wechat.miniAppSecret, apiBaseUrl: wechat.url },
  });

  log('h5 build …');
  await ensureH5Build({ log });

  const buildId = path.join(WEB_DIR, '.next', 'BUILD_ID');
  if (process.env.SHOP_E2E_BUILD === '1' || !existsSync(buildId)) {
    log('next build …');
    await run('pnpm', ['exec', 'next', 'build'], WEB_DIR, {
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      NODE_ENV: 'production',
    });
  }

  const sharedEnv: NodeJS.ProcessEnv = {
    // `next start` needs NODE_ENV=test, not production, for the same reason
    // `@shop/e2e-admin` gives: a Secure cookie over plain http would be
    // dropped by Playwright's cookie jar. The storefront's own bearer-token
    // auth does not depend on this, but the admin surfaces this stack also
    // exercises (ship, refund) do.
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    UPLOADS_DIR: uploadsDir,
    UPLOADS_PUBLIC_PREFIX: '/uploads',
    APP_ORIGIN: BASE_URL,
    VALIDATE_RESPONSES: '1',
    LOG_LEVEL: process.env.SHOP_E2E_LOG_LEVEL ?? 'warn',
    APP_VERSION: 'e2e',
    // `web` registers the in-memory fake SMS sender in its own module graph
    // when this is set, so the SMS sign-in journey never reaches a provider.
    SHOP_FAKE_SMS: '1',
  };

  log(`next start on :${WEB_PORT}`);
  spawnLong(
    'next start',
    'pnpm',
    ['exec', 'next', 'start', '--port', String(WEB_PORT), '--hostname', '127.0.0.1'],
    WEB_DIR,
    sharedEnv,
  );

  log('starting worker …');
  spawnLong('worker', 'pnpm', ['exec', 'tsx', 'src/main.ts'], WORKER_DIR, {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    UPLOADS_DIR: uploadsDir,
    UPLOADS_PUBLIC_PREFIX: '/uploads',
    LOG_LEVEL: process.env.SHOP_E2E_LOG_LEVEL ?? 'warn',
  });

  await waitForHealthy(`${WEB_URL}/api/v1/health`);

  log(`starting edge on :${EDGE_PORT}, root=${H5_DIST_DIR}, upstream=${WEB_URL}`);
  const edge = await startEdge({
    port: EDGE_PORT,
    root: H5_DIST_DIR,
    uploadsDir,
    upstream: WEB_URL,
    controlUpstream: control.url,
  });
  closeEdge = edge.close;

  const info: StackInfo = {
    databaseUrl,
    redisUrl,
    baseUrl: BASE_URL,
    wechatMiniAppId: wechat.miniAppId,
    uploadsDir,
    gatewayUrl: gateway.url,
    gatewayControlUrl: control.url,
    admin: seeded.admin,
    users: seeded.users,
    fixtures: seeded.fixtures,
  };
  await writeFile(STACK_FILE, JSON.stringify(info, null, 2), 'utf8');

  log(`stack ready in ${Date.now() - started}ms → ${STACK_FILE}`);
}

async function waitForHealthy(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline)
      throw new Error(`${url} did not become healthy within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function shutdown(code = 0): Promise<void> {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  await closeEdge?.().catch(() => {});
  await closeGatewayControl?.().catch(() => {});
  await closeGateway?.().catch(() => {});
  await closeWechat?.().catch(() => {});
  await stopTemplate?.().catch(() => {});
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(0));
}

main().catch(async (error: unknown) => {
  console.error('[e2e] stack failed to start');
  console.error(error);
  await shutdown(1);
});
