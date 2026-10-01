/**
 * The whole stack, in one process, for `playwright.config.ts`'s `webServer`.
 *
 *   1. PostgreSQL 17 + Redis 7 (Testcontainers, or an already-running pair via
 *      `SHOP_TEST_PG_URL` / `SHOP_TEST_REDIS_URL`), and the schema, through
 *      `@shop/testing`'s own global setup — the same code the integration
 *      suite uses, so the two can never drift apart;
 *   2. a database cloned from that template, seeded with the fixtures in
 *      `src/seed.ts`;
 *   3. `next build`, if the app has not been built yet;
 *   4. `next start`, against those two connection strings;
 *   5. the handoff file the specs read.
 *
 * Run it directly to keep a stack warm between Playwright runs, and opt the
 * runs into attaching to it:
 *
 *     pnpm --filter @shop/e2e-admin exec tsx scripts/serve.ts
 *     SHOP_E2E_REUSE=1 pnpm --filter @shop/e2e-admin e2e
 *
 * The port and handoff file default to values derived from this checkout's
 * path (`src/stack-file.ts`), so a warm stack in one worktree is invisible to
 * the suite in another.
 *
 * Nothing here talks to WeChat, an SMS gateway or Aliyun. The payment and
 * notification configuration the seed writes is fixture data pointing at
 * nothing, and the specs never trigger a real send.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';

import { seedE2E } from '../src/seed';
import { PORT, STACK_FILE, BASE_URL, type StackInfo } from '../src/stack-file';

const HERE = import.meta.dirname;
const WEB_DIR = path.resolve(HERE, '../../../apps/web');
const E2E_DATABASE = process.env.SHOP_E2E_DATABASE ?? 'shop_e2e';

let child: ChildProcess | undefined;
let stopTemplate: (() => Promise<void>) | undefined;

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    );
  });
}

/** `CREATE DATABASE … TEMPLATE …` — a file copy inside PostgreSQL, tens of ms. */
async function cloneTemplate(adminUrl: string, template: string): Promise<string> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Anything still attached would make DROP fail; the previous run's server
    // is gone by now, but a warm stack may have left a pool behind.
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

  // `handle.ts` imports `@shop/core/domains`, which is `domains.gen.ts`, which
  // `pnpm gen` writes and `.gitignore` excludes. Without this, `next build`
  // fails to resolve it. turbo caches the run, so a warm repeat costs ~100ms.
  console.log('[e2e] pnpm gen …');
  await run('pnpm', ['--workspace-root', 'run', 'gen'], path.resolve(HERE, '..'));

  // `@shop/testing`'s setup publishes SHOP_TEST_PG_URL / SHOP_TEST_REDIS_URL
  // and builds `shop_template` with the current schema.
  const harness = await import('@shop/testing/global-setup');
  await harness.setup();
  stopTemplate = harness.teardown;

  const pgAdminUrl = process.env.SHOP_TEST_PG_URL!;
  const redisUrl = process.env.SHOP_TEST_REDIS_URL!;
  const databaseUrl = await cloneTemplate(
    pgAdminUrl,
    process.env.SHOP_TEST_TEMPLATE ?? 'shop_template',
  );

  const uploadsDir = await mkdtemp(path.join(tmpdir(), 'shop-e2e-uploads-'));

  console.log('[e2e] seeding …');
  const seeded = await seedE2E({ databaseUrl, redisUrl, uploadsDir });

  const info: StackInfo = {
    databaseUrl,
    redisUrl,
    baseUrl: BASE_URL,
    uploadsDir,
    accounts: seeded.accounts,
    fixtures: seeded.fixtures,
  };
  await writeFile(STACK_FILE, JSON.stringify(info, null, 2), 'utf8');

  const buildId = path.join(WEB_DIR, '.next', 'BUILD_ID');
  if (process.env.SHOP_E2E_BUILD === '1' || !existsSync(buildId)) {
    console.log('[e2e] next build …');
    // The build never opens a connection — nothing renders at build time — but
    // `loadEnv()` runs when a route module is first evaluated, so it has to
    // parse. Giving it the real URLs costs nothing and removes a class of
    // "works locally, fails in CI" difference.
    await run('pnpm', ['exec', 'next', 'build'], WEB_DIR, {
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      NODE_ENV: 'production',
    });
  }

  console.log(`[e2e] next start on :${PORT}`);
  child = spawn(
    'pnpm',
    ['exec', 'next', 'start', '--port', String(PORT), '--hostname', '127.0.0.1'],
    {
      cwd: WEB_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        // A production *build*, served with NODE_ENV=test, for exactly one
        // reason: `handle()` marks the `admin_session` cookie `Secure` when
        // NODE_ENV is production (`handle.ts` → `isProduction`), and a Secure
        // cookie over plain `http://127.0.0.1` is dropped by Playwright's own
        // cookie jar, so every spec would fail at login. `next start` keeps an
        // explicit NODE_ENV, and the bundle it serves was built as production.
        //
        // That flag is therefore the one production behaviour this suite does
        // not exercise. In production the front proxy terminates TLS, and
        // `handle.int.test.ts` asserts the attribute directly.
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        UPLOADS_DIR: uploadsDir,
        UPLOADS_PUBLIC_PREFIX: '/uploads',
        APP_ORIGIN: BASE_URL,
        // The merge gate runs with response validation on, and so does this
        // suite: a response that does not match its contract must fail here too.
        VALIDATE_RESPONSES: '1',
        LOG_LEVEL: process.env.SHOP_E2E_LOG_LEVEL ?? 'warn',
        APP_VERSION: 'e2e',
        // The decor editor's preview frames this URL. There is no H5 build of
        // the storefront in this stack, so it frames the storefront's own read
        // of the draft — what the H5 page would receive (decor.spec.ts).
        DECOR_PREVIEW_URL: '/api/v1/pages/{id}?previewToken={previewToken}',
      },
    },
  );
  child.on('exit', (code) => {
    console.error(`[e2e] next exited with ${code}`);
    void shutdown(code ?? 1);
  });

  console.log(`[e2e] stack ready in ${Date.now() - started}ms → ${STACK_FILE}`);
}

async function shutdown(code = 0): Promise<void> {
  child?.kill('SIGTERM');
  child = undefined;
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
