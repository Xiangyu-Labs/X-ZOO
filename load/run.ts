/**
 * The load smoke.
 *
 *     pnpm --filter @shop/e2e-admin exec tsx ../../load/run.ts
 *
 * One process owns everything and tears everything down, on success, failure
 * or Ctrl-C:
 *
 *  1. PostgreSQL 17 and Redis 7 as plain `docker run` containers with the
 *     memory limits and tuning of `deploy/compose.yml` (swap disabled, so
 *     the limit is a limit), plus `pg_stat_statements`;
 *  2. the schema through `@shop/testing`'s global setup, a database cloned
 *     from the template, a storefront seeded through the core services;
 *  3. the fake WeChat Pay gateway (`@shop/testing/wechat`), in this process;
 *  4. the web app as the production image runs it (the standalone server in
 *     `apps/web/.next/standalone`) and the worker
 *     (`apps/worker/dist/main.js`), each in its own cgroup via
 *     `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0`, with the
 *     compose file's `--max-old-space-size`;
 *  5. shoppers signing in and adding an address over HTTP; a one-pass smoke of
 *     every flow; a wait for the machine to calm down; 15 s warm-up; 60 s
 *     measured; `pg_stat_statements` reset at the boundary.
 *
 * Everything binds to 127.0.0.1 and nothing leaves the machine. Results land
 * in `$TMPDIR/shop-load/<timestamp>/` (never in the repository).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir, totalmem, release } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { dep, NEXT_DIR } from './lib/deps';
import { seedStorefront, type SeedResult } from './lib/seed';
import {
  fmt,
  readCgroup,
  summarise,
  summariseMemory,
  type EndpointSummary,
  type MemorySeries,
  type MemorySummary,
  type Sample,
} from './lib/stats';

// ---------------------------------------------------------------------------
// knobs
// ---------------------------------------------------------------------------

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const VUS = env('SHOP_LOAD_VUS', 16);
const SECONDS = env('SHOP_LOAD_SECONDS', 60);
const WARMUP = env('SHOP_LOAD_WARMUP', 15);
const WEB_PORT = env('SHOP_LOAD_PORT', 3471);
const PG_PORT = env('SHOP_LOAD_PG_PORT', 55471);
const REDIS_PORT = env('SHOP_LOAD_REDIS_PORT', 56471);
const MAX_LOAD = env('SHOP_LOAD_MAX_LOADAVG', 12);
const MAX_WAIT_MIN = env('SHOP_LOAD_MAX_WAIT_MIN', 30);
const PRODUCTS = 20;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const DATABASE = 'shop_load';
const PREFIX = 'shop-load';

const OUT = path.join(tmpdir(), 'shop-load', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(OUT, { recursive: true });

/** compose.yml's limits, in MiB. `edge` is not run: nothing here needs nginx. */
const BUDGET = { postgres: 512, redis: 160, web: 512, worker: 320, edge: 64 } as const;
const BUDGET_TOTAL = 1568;

const log = (...args: unknown[]) => console.log('[load]', ...args);

// ---------------------------------------------------------------------------
// teardown — registered as things come up, run in reverse, exactly once
// ---------------------------------------------------------------------------

const cleanups: { name: string; fn: () => Promise<void> | void }[] = [];
let tornDown = false;

async function teardown(): Promise<void> {
  if (tornDown) return;
  tornDown = true;
  for (const { name, fn } of cleanups.reverse()) {
    try {
      await fn();
    } catch (error) {
      console.error(`[load] cleanup ${name} failed:`, error);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error(`[load] ${signal} — tearing down`);
    void teardown().then(() => process.exit(130));
  });
}

function sh(command: string, args: string[], opts: { quiet?: boolean } = {}): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'inherit'],
  }).trim();
}

function shQuiet(command: string, args: string[]): void {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
  } catch {
    // best effort
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. postgres + redis
// ---------------------------------------------------------------------------

const PG_CONTAINER = `${PREFIX}-postgres`;
const REDIS_CONTAINER = `${PREFIX}-redis`;

function startDatabases(): { pgUrl: string; redisUrl: string } {
  shQuiet('docker', ['rm', '-f', PG_CONTAINER, REDIS_CONTAINER]);
  cleanups.push({
    name: 'containers',
    fn: () => shQuiet('docker', ['rm', '-f', '-v', PG_CONTAINER, REDIS_CONTAINER]),
  });

  // compose.yml's postgres command, verbatim, plus pg_stat_statements.
  sh('docker', [
    'run',
    '-d',
    '--name',
    PG_CONTAINER,
    '--memory',
    '512m',
    '--memory-swap',
    '512m',
    '-p',
    `127.0.0.1:${PG_PORT}:5432`,
    '-e',
    'POSTGRES_USER=shop',
    '-e',
    'POSTGRES_PASSWORD=shop',
    '-e',
    'POSTGRES_DB=shop',
    '-e',
    'TZ=Asia/Shanghai',
    '-e',
    'PGTZ=Asia/Shanghai',
    'postgres:17-alpine',
    'postgres',
    '-c',
    'shared_buffers=128MB',
    '-c',
    'effective_cache_size=256MB',
    '-c',
    'work_mem=4MB',
    '-c',
    'maintenance_work_mem=64MB',
    '-c',
    'max_connections=40',
    '-c',
    'log_min_duration_statement=1000',
    '-c',
    'shared_preload_libraries=pg_stat_statements',
    '-c',
    'pg_stat_statements.track=top',
  ]);

  // compose.yml's redis command, minus the password (loopback only).
  sh('docker', [
    'run',
    '-d',
    '--name',
    REDIS_CONTAINER,
    '--memory',
    '160m',
    '--memory-swap',
    '160m',
    '-p',
    `127.0.0.1:${REDIS_PORT}:6379`,
    'redis:7-alpine',
    'redis-server',
    '--appendonly',
    'yes',
    '--appendfsync',
    'everysec',
    '--maxmemory',
    '96mb',
    '--maxmemory-policy',
    'noeviction',
  ]);

  return {
    pgUrl: `postgres://shop:shop@127.0.0.1:${PG_PORT}/shop`,
    redisUrl: `redis://127.0.0.1:${REDIS_PORT}/0`,
  };
}

async function waitForPostgres(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      // Against the real database over TCP: the init scripts run with the
      // socket only, so a TCP answer means the final server is up.
      execFileSync(
        'docker',
        ['exec', PG_CONTAINER, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'shop', '-d', 'shop'],
        { stdio: 'ignore' },
      );
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('postgres did not become ready');
}

async function cloneDatabase(pgUrl: string): Promise<string> {
  const pg = (await dep('pg')).default;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
    await admin.query(`CREATE DATABASE ${DATABASE} TEMPLATE shop_template`);
  } finally {
    await admin.end();
  }
  const url = new URL(pgUrl);
  url.pathname = `/${DATABASE}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  await client.end();
  return url.toString();
}

// ---------------------------------------------------------------------------
// 4. web + worker, each in a memory-limited cgroup
// ---------------------------------------------------------------------------

interface Service {
  name: 'web' | 'worker';
  unit: string;
  child: ChildProcess;
  cgroupDir: string;
}

async function startScoped(
  name: Service['name'],
  memoryMax: string,
  cwd: string,
  argv: string[],
  extraEnv: NodeJS.ProcessEnv,
): Promise<Service> {
  const unit = `${PREFIX}-${name}`;
  shQuiet('systemctl', ['--user', 'stop', `${unit}.scope`]);
  shQuiet('systemctl', ['--user', 'reset-failed', `${unit}.scope`]);
  const logFile = createWriteStream(path.join(OUT, `${name}.log`));
  const child = spawn(
    'systemd-run',
    [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--unit=${unit}`,
      '-p',
      `MemoryMax=${memoryMax}`,
      '-p',
      'MemorySwapMax=0',
      ...argv,
    ],
    { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout!.pipe(logFile);
  child.stderr!.pipe(logFile);
  child.on('exit', (code, signal) => {
    if (!tornDown) console.error(`[load] ${name} exited early: code=${code} signal=${signal}`);
  });
  cleanups.push({
    name,
    fn: async () => {
      child.kill('SIGTERM');
      for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) {
        await sleep(250);
      }
      shQuiet('systemctl', ['--user', 'stop', `${unit}.scope`]);
    },
  });

  let cgroup = '';
  for (let i = 0; i < 40 && !cgroup; i++) {
    await sleep(250);
    try {
      cgroup = sh(
        'systemctl',
        ['--user', 'show', '-p', 'ControlGroup', '--value', `${unit}.scope`],
        {
          quiet: true,
        },
      );
    } catch {
      // not registered yet
    }
  }
  if (!cgroup) throw new Error(`${unit}.scope never appeared`);
  return { name, unit, child, cgroupDir: `/sys/fs/cgroup${cgroup}` };
}

function dockerCgroup(container: string): string {
  const id = sh('docker', ['inspect', '-f', '{{.Id}}', container]);
  return `/sys/fs/cgroup/system.slice/docker-${id}.scope`;
}

async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await probe().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`${what} not ready after ${timeoutMs} ms`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface Shopper {
  id: number;
  account: string;
  token: string;
  addressId: string;
}

let samples: Sample[] = [];
let measureStart = 0;
let measureEnd = Number.POSITIVE_INFINITY;
let recording = false;

function record(endpoint: string, started: number, ms: number, status: number) {
  if (!recording) return;
  if (started < measureStart || started >= measureEnd) return;
  samples.push({
    endpoint,
    ms,
    status,
    ok: status >= 200 && status < 300,
    at: started - measureStart,
  });
}

interface Answer {
  status: number;
  body: any;
  text: string;
}

async function call(
  endpoint: string,
  method: string,
  url: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-client-platform': 'wechat-oa',
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const started = performance.now();
  try {
    const res = await fetch(BASE + url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    record(endpoint, started, performance.now() - started, res.status);
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body, text };
  } catch (error) {
    record(endpoint, started, performance.now() - started, 0);
    return { status: 0, body: null, text: String(error) };
  }
}

// ---------------------------------------------------------------------------
// the flows
// ---------------------------------------------------------------------------

type Gateway = Awaited<
  ReturnType<
    (typeof import('../packages/testing/src/wechat/fake-gateway'))['startFakeWechatGateway']
  >
>;

interface World {
  seed: SeedResult;
  gateway: Gateway;
}

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

type Flow = (world: World, shopper: Shopper) => Promise<string | null>;

/** Each returns `null` on success or a one-line reason, which the smoke pass reports. */
const FLOWS: Record<string, { weight: number; run: Flow }> = {
  home: {
    weight: 20,
    run: async () => {
      const r = await call('GET /api/v1/pages/home', 'GET', '/api/v1/pages/home');
      return r.status === 200 ? null : `home ${r.status} ${r.text.slice(0, 300)}`;
    },
  },
  category: {
    weight: 20,
    run: async (world) => {
      const tree = await call(
        'GET /api/v1/catalog/categories',
        'GET',
        '/api/v1/catalog/categories',
      );
      if (tree.status !== 200) return `categories ${tree.status} ${tree.text.slice(0, 300)}`;
      const categoryId = pick(world.seed.categoryIds);
      const list = await call(
        'GET /api/v1/catalog/products?categoryId',
        'GET',
        `/api/v1/catalog/products?page=1&pageSize=20&categoryId=${categoryId}`,
      );
      if (list.status !== 200) return `products ${list.status} ${list.text.slice(0, 300)}`;
      if (!Array.isArray(list.body?.items) || list.body.items.length === 0) {
        return `products: empty page for category ${categoryId}`;
      }
      return null;
    },
  },
  detail: {
    weight: 25,
    run: async (world, shopper) => {
      const product = pick(world.seed.products);
      const r = await call(
        'GET /api/v1/catalog/products/:id',
        'GET',
        `/api/v1/catalog/products/${product.id}`,
        {
          token: shopper.token,
        },
      );
      return r.status === 200 ? null : `detail ${r.status} ${r.text.slice(0, 300)}`;
    },
  },
  cartAdd: {
    weight: 15,
    run: async (world, shopper) => {
      const product = pick(world.seed.products);
      const r = await call('POST /api/v1/cart/items', 'POST', '/api/v1/cart/items', {
        token: shopper.token,
        body: { skuId: product.skuId, quantity: 1 },
      });
      return r.status >= 200 && r.status < 300
        ? null
        : `cart add ${r.status} ${r.text.slice(0, 300)}`;
    },
  },
  preview: {
    weight: 10,
    run: async (world, shopper) => {
      const product = pick(world.seed.products);
      const r = await call('POST /api/v1/checkout/preview', 'POST', '/api/v1/checkout/preview', {
        token: shopper.token,
        body: {
          source: 'buy-now',
          item: { skuId: product.skuId, quantity: 1 },
          addressId: shopper.addressId,
          kind: 'normal',
        },
      });
      return r.status === 200 ? null : `preview ${r.status} ${r.text.slice(0, 300)}`;
    },
  },
  orderAndPay: {
    weight: 10,
    run: async (world, shopper) => {
      const product = pick(world.seed.products);
      const created = await call('POST /api/v1/orders', 'POST', '/api/v1/orders', {
        token: shopper.token,
        body: {
          source: 'buy-now',
          item: { skuId: product.skuId, quantity: 1 },
          addressId: shopper.addressId,
          kind: 'normal',
          idempotencyKey: `shopload-${randomBytes(12).toString('hex')}`,
        },
      });
      if (created.status !== 201)
        return `order create ${created.status} ${created.text.slice(0, 300)}`;
      const orderId = String(created.body.id);
      const intent = await call(
        'POST /api/v1/orders/:id/payments',
        'POST',
        `/api/v1/orders/${orderId}/payments`,
        {
          token: shopper.token,
          body: {
            channel: 'wechat_oa',
            openid: `oLoadShopper${String(shopper.id).padStart(12, '0')}`,
          },
        },
      );
      if (intent.status !== 201)
        return `payment start ${intent.status} ${intent.text.slice(0, 300)}`;
      const outTradeNo = String(intent.body.outTradeNo);
      world.gateway.markPaid(outTradeNo);
      // The gateway signs and delivers; the latency is the app's webhook.
      const started = performance.now();
      let status = 0;
      let text = '';
      try {
        const answer = await world.gateway.postNotify(`${BASE}/api/v1/webhooks/wechat-pay`, {
          outTradeNo,
        });
        status = answer.status;
        text = answer.body;
      } catch (error) {
        text = String(error);
      }
      record('POST /api/v1/webhooks/wechat-pay', started, performance.now() - started, status);
      return status === 200 ? null : `notify ${status} ${text.slice(0, 300)}`;
    },
  },
};

// ---------------------------------------------------------------------------
// shoppers
// ---------------------------------------------------------------------------

async function signIn(seed: SeedResult): Promise<Shopper[]> {
  const out: Shopper[] = [];
  for (const s of seed.shoppers) {
    const login = await call('login', 'POST', '/api/v1/auth/sessions/password', {
      body: { account: s.account, password: s.password },
    });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`login ${s.account}: ${login.status} ${login.text.slice(0, 400)}`);
    }
    const token = String(login.body.token);
    const address = await call('address', 'POST', '/api/v1/addresses', {
      token,
      body: {
        receiverName: '压测收货人',
        receiverPhone: '13800138000',
        ...seed.region,
        provinceName: '广东省',
        cityName: '深圳市',
        districtName: '南山区',
        detail: '科技园路 1 号',
        postCode: '518057',
        isDefault: true,
      },
    });
    if (address.status !== 201) {
      throw new Error(`address ${s.account}: ${address.status} ${address.text.slice(0, 400)}`);
    }
    out.push({ id: s.id, account: s.account, token, addressId: String(address.body.id) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function waitForQuietMachine(): Promise<{ waitedS: number; atStart: number[] }> {
  const started = Date.now();
  let [one] = loadavg();
  while (one! > MAX_LOAD && Date.now() - started < MAX_WAIT_MIN * 60_000) {
    log(`1-min load average ${one!.toFixed(1)} > ${MAX_LOAD}; waiting 60 s …`);
    await sleep(60_000);
    [one] = loadavg();
  }
  if (one! > MAX_LOAD) log(`still ${one!.toFixed(1)} after ${MAX_WAIT_MIN} min — running anyway`);
  return { waitedS: Math.round((Date.now() - started) / 1000), atStart: loadavg() };
}

function weightedPicker(names: string[]): () => string {
  const table: string[] = [];
  for (const name of names) for (let i = 0; i < FLOWS[name]!.weight; i++) table.push(name);
  return () => pick(table);
}

async function runLoad(
  world: World,
  shoppers: Shopper[],
  names: string[],
  onBoundary: () => Promise<void>,
) {
  const next = weightedPicker(names);
  const t0 = performance.now();
  measureStart = t0 + WARMUP * 1000;
  measureEnd = measureStart + SECONDS * 1000;
  recording = true;
  const boundary = setTimeout(() => void onBoundary(), WARMUP * 1000);
  const flowCounts: Record<string, number> = {};
  const flowFailures: Record<string, string[]> = {};

  await Promise.all(
    Array.from({ length: VUS }, async (_, vu) => {
      const shopper = shoppers[vu % shoppers.length]!;
      while (performance.now() < measureEnd) {
        const name = next();
        const started = performance.now();
        const failure = await FLOWS[name]!.run(world, shopper);
        if (started >= measureStart && started < measureEnd) {
          flowCounts[name] = (flowCounts[name] ?? 0) + 1;
          if (failure) (flowFailures[name] ??= []).push(failure);
        }
      }
    }),
  );
  clearTimeout(boundary);
  recording = false;
  return { flowCounts, flowFailures };
}

async function main() {
  const machine = {
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    ramGiB: totalmem() / 1024 ** 3,
    kernel: release(),
  };
  log(
    `machine: ${machine.cpu}, ${machine.cores} cores, ${machine.ramGiB.toFixed(1)} GiB, ${machine.kernel}`,
  );
  log(`output → ${OUT}`);

  // -- 1. databases -----------------------------------------------------------
  const { pgUrl, redisUrl } = startDatabases();
  await waitForPostgres();
  log('postgres + redis up');

  // -- 2. schema, clone, seed -------------------------------------------------
  process.env.SHOP_TEST_PG_URL = pgUrl;
  process.env.SHOP_TEST_REDIS_URL = redisUrl;
  const harness = await dep('@shop/testing/global-setup');
  await harness.setup();
  const databaseUrl = await cloneDatabase(pgUrl);

  const { startFakeWechatGateway } = await dep('@shop/testing/wechat');
  const gateway: Gateway = await startFakeWechatGateway();
  cleanups.push({ name: 'gateway', fn: () => gateway.close() });
  log(`fake WeChat Pay gateway on ${gateway.url}`);

  const uploadsDir = path.join(OUT, 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  const seed = await seedStorefront({
    databaseUrl,
    redisUrl,
    uploadsDir,
    gateway: { url: gateway.url, keys: gateway.keys },
    appOrigin: BASE,
    shoppers: VUS,
    products: PRODUCTS,
  });
  log(
    `seeded ${seed.products.length} products, ${seed.categoryIds.length} leaf categories, ${seed.shoppers.length} shoppers`,
  );

  // -- 3. web + worker --------------------------------------------------------
  const webDir = path.join(NEXT_DIR, 'apps/web');
  const workerDir = path.join(NEXT_DIR, 'apps/worker');
  if (!existsSync(path.join(webDir, '.next/standalone/apps/web/server.js'))) {
    throw new Error(
      'apps/web/.next is missing — run `pnpm turbo run build --filter @shop/web` from the repository root first',
    );
  }
  if (!existsSync(path.join(workerDir, 'dist/main.js'))) {
    throw new Error(
      'apps/worker/dist is missing — run `pnpm turbo run build --filter @shop/worker` from the repository root first',
    );
  }
  const common = {
    NODE_ENV: 'production',
    TZ: 'Asia/Shanghai',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    UPLOADS_DIR: uploadsDir,
    UPLOADS_PUBLIC_PREFIX: '/uploads',
    HEARTBEAT_INTERVAL_MS: '15000',
    LOG_LEVEL: process.env.SHOP_LOAD_LOG_LEVEL ?? 'warn',
    QUEUE_NAME: 'shop',
  };
  const worker = await startScoped(
    'worker',
    '320M',
    workerDir,
    [process.execPath, 'dist/main.js'],
    {
      ...common,
      NODE_OPTIONS: '--max-old-space-size=224',
      DB_POOL_MAX: '5',
      WORKER_CONCURRENCY: '4',
    },
  );
  const web = await startScoped(
    'web',
    '512M',
    // The production image's entry point (`docker/web.Dockerfile`): the
    // standalone server, not `next start`, which refuses `output: standalone`.
    path.join(webDir, '.next/standalone'),
    [process.execPath, 'apps/web/server.js'],
    {
      ...common,
      HOSTNAME: '127.0.0.1',
      NODE_OPTIONS: '--max-old-space-size=384',
      PORT: String(WEB_PORT),
      APP_ORIGIN: BASE,
      APP_VERSION: 'shop-load',
      DB_POOL_MAX: '10',
      VALIDATE_RESPONSES: '0',
    },
  );
  let lastReady = '';
  await waitFor(
    'web + worker (/api/v1/readyz)',
    async () => {
      // `migrations` is ignored: `@shop/testing` replays the migration SQL
      // without drizzle's journal table, so that one check always fails here.
      // Database, Redis and the worker's heartbeat are what "up" means.
      const res = await fetch(`${BASE}/api/v1/readyz`);
      lastReady = `${res.status} ${await res.text()}`;
      const checks = (
        JSON.parse(lastReady.slice(4)) as { details?: { checks?: Record<string, string> } }
      ).details?.checks;
      if (res.status === 200) return true;
      return !!checks && ['database', 'redis', 'worker'].every((k) => checks[k] === 'ok');
    },
    180_000,
  ).catch((error: Error) => {
    throw new Error(`${error.message}; last answer: ${lastReady.slice(0, 600)}`);
  });
  log(`web on ${BASE} (${web.cgroupDir}), worker (${worker.cgroupDir}) — ready`);

  const cgroups = {
    postgres: dockerCgroup(PG_CONTAINER),
    redis: dockerCgroup(REDIS_CONTAINER),
    web: web.cgroupDir,
    worker: worker.cgroupDir,
  };
  for (const [name, dir] of Object.entries(cgroups)) {
    if (!readCgroup(dir)) throw new Error(`cannot read ${name}'s cgroup at ${dir}`);
  }

  // -- 4. shoppers, smoke -----------------------------------------------------
  const shoppers = await signIn(seed);
  log(`${shoppers.length} shoppers signed in with an address`);

  const world: World = { seed, gateway };
  const usable: string[] = [];
  const skipped: Record<string, string> = {};
  for (const [name, flow] of Object.entries(FLOWS)) {
    const failure = await flow.run(world, shoppers[0]!);
    if (failure) {
      skipped[name] = failure;
      log(`smoke: ${name} FAILED — ${failure}`);
    } else {
      usable.push(name);
      log(`smoke: ${name} ok`);
    }
  }
  if (usable.length === 0) throw new Error('no flow can be driven');

  // -- 5. wait for a quiet machine, warm up, measure --------------------------
  const quiet = await waitForQuietMachine();
  log(
    `load average at start ${quiet.atStart.map((x) => x.toFixed(2)).join(' / ')}; ${VUS} VUs, ${WARMUP} s warm-up + ${SECONDS} s`,
  );

  const pg = (await dep('pg')).default;
  const stats = new pg.Client({ connectionString: databaseUrl });
  await stats.connect();
  cleanups.push({ name: 'stats client', fn: () => stats.end() });

  const series: Record<string, MemorySeries> = Object.fromEntries(
    (['postgres', 'redis', 'web', 'worker'] as const).map((s) => [
      s,
      { service: s, limitMiB: BUDGET[s], readings: [] },
    ]),
  );
  let sampler: NodeJS.Timeout | undefined;
  const sampleMemory = () => {
    for (const [name, dir] of Object.entries(cgroups)) {
      const reading = readCgroup(dir);
      if (reading) series[name]!.readings.push({ at: performance.now() - measureStart, reading });
    }
  };

  const loadSamples: { at: number; load: number[] }[] = [];
  const { flowCounts, flowFailures } = await runLoad(world, shoppers, usable, async () => {
    await stats.query('SELECT pg_stat_statements_reset()');
    sampleMemory();
    sampler = setInterval(() => {
      sampleMemory();
      loadSamples.push({ at: performance.now() - measureStart, load: loadavg() });
    }, 2000);
    log('warm-up over — measuring');
  });
  clearInterval(sampler);
  sampleMemory();
  const loadAtEnd = loadavg();
  log(
    `measured window over; load average at end ${loadAtEnd.map((x) => x.toFixed(2)).join(' / ')}`,
  );

  // -- 6. read back -----------------------------------------------------------
  const top = async (order: string, limit = 15) =>
    (
      await stats.query(
        `SELECT s.queryid::text, s.calls::int, round(s.total_exec_time::numeric, 1)::float AS total_ms,
                round(s.mean_exec_time::numeric, 3)::float AS mean_ms, s.rows::int, s.query
           FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid
          WHERE d.datname = $1 AND s.query NOT ILIKE '%pg_stat_statements%'
          ORDER BY ${order} DESC LIMIT ${limit}`,
        [DATABASE],
      )
    ).rows;
  const byTime = await top('s.total_exec_time');
  const byCalls = await top('s.calls');
  // Everything, for the calls-per-request arithmetic an N+1 hunt needs.
  const all = await top('s.calls', 500);
  const totals = (
    await stats.query(
      `SELECT sum(s.calls)::int AS calls, round(sum(s.total_exec_time)::numeric, 1)::float AS total_ms, count(*)::int AS statements
         FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = $1`,
      [DATABASE],
    )
  ).rows[0];

  // Let the worker drain what the run queued, then read the outcome.
  await sleep(5000);
  const outcome = {
    orders: (
      await stats.query(`SELECT status::text, count(*)::int FROM orders GROUP BY 1 ORDER BY 1`)
    ).rows,
    effects: (
      await stats
        .query(
          `SELECT scope::text, event_type, status::text, count(*)::int FROM effects GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
        )
        .catch(() => ({
          rows: [],
        }))
    ).rows,
    failedJobs: (
      await stats
        .query(`SELECT count(*)::int AS n FROM failed_jobs`)
        .catch(() => ({ rows: [{ n: null }] }))
    ).rows[0]?.n,
  };

  // -- 7. summarise -----------------------------------------------------------
  const endpoints = [...new Set(samples.map((s) => s.endpoint))];
  const perEndpoint: EndpointSummary[] = endpoints
    .map((e) =>
      summarise(
        samples.filter((s) => s.endpoint === e),
        e,
        SECONDS,
      ),
    )
    .sort((a, b) => b.count - a.count);
  const overall = summarise(samples, 'overall', SECONDS);
  const memory: MemorySummary[] = Object.values(series).map(summariseMemory);
  const memoryTotal = {
    steadyWorkingSetMiB: memory.reduce((a, m) => a + m.steadyWorkingSetMiB, 0),
    peakWorkingSetMiB: memory.reduce((a, m) => a + m.peakWorkingSetMiB, 0),
    peakCurrentMiB: memory.reduce((a, m) => a + m.peakCurrentMiB, 0),
    cgroupPeakMiB: memory.reduce((a, m) => a + m.cgroupPeakMiB, 0),
    budgetRunMiB: BUDGET_TOTAL - BUDGET.edge,
    budgetMiB: BUDGET_TOTAL,
  };

  const errorExamples: Record<string, string[]> = {};
  for (const [name, reasons] of Object.entries(flowFailures)) {
    errorExamples[name] = [...new Set(reasons.map((r) => r.slice(0, 200)))].slice(0, 5);
  }

  const result = {
    at: new Date().toISOString(),
    machine,
    loadAverage: {
      waitedS: quiet.waitedS,
      atStart: quiet.atStart,
      atEnd: loadAtEnd,
      during: loadSamples,
    },
    config: {
      vus: VUS,
      seconds: SECONDS,
      warmup: WARMUP,
      weights: Object.fromEntries(usable.map((n) => [n, FLOWS[n]!.weight])),
    },
    skipped,
    flowCounts,
    errorExamples,
    overall,
    perEndpoint,
    memory,
    memoryTotal,
    pg: { totals, byTime, byCalls, all },
    outcome,
    buildId: sh('cat', [path.join(webDir, '.next/BUILD_ID')]),
  };
  writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  const tables = renderTables(result);
  writeFileSync(path.join(OUT, 'tables.md'), tables);
  console.log('\n' + tables);
  log(`written ${path.join(OUT, 'result.json')} and tables.md`);
}

function renderTables(r: any): string {
  const lines: string[] = [];
  lines.push(
    `VUs ${r.config.vus}, ${r.config.seconds} s measured after ${r.config.warmup} s warm-up.`,
  );
  lines.push('');
  lines.push(
    '| Endpoint | Count | req/s | p50 ms | p95 ms | p99 ms | max ms | Errors | Error rate |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const e of [...r.perEndpoint, r.overall] as EndpointSummary[]) {
    lines.push(
      `| ${e.endpoint === 'overall' ? '**overall**' : '`' + e.endpoint + '`'} | ${e.count} | ${fmt(e.rps)} | ${fmt(e.p50)} | ${fmt(e.p95)} | ${fmt(e.p99)} | ${fmt(e.max)} | ${e.errors} | ${fmt(e.errorRate * 100, 2)} % |`,
    );
  }
  lines.push('');
  lines.push(
    '| Service | Limit MiB | Steady (median) MiB | Peak MiB | Peak anon MiB | Peak memory.current MiB | cgroup memory.peak MiB |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const m of r.memory as MemorySummary[]) {
    lines.push(
      `| ${m.service} | ${m.limitMiB} | ${fmt(m.steadyWorkingSetMiB)} | ${fmt(m.peakWorkingSetMiB)} | ${fmt(m.peakAnonMiB)} | ${fmt(m.peakCurrentMiB)} | ${fmt(m.cgroupPeakMiB)} |`,
    );
  }
  lines.push(
    `| **total (4 services)** | ${r.memoryTotal.budgetRunMiB} (of ${r.memoryTotal.budgetMiB}) | ${fmt(r.memoryTotal.steadyWorkingSetMiB)} | ${fmt(r.memoryTotal.peakWorkingSetMiB)} | | ${fmt(r.memoryTotal.peakCurrentMiB)} | ${fmt(r.memoryTotal.cgroupPeakMiB)} |`,
  );
  lines.push('');
  const pgTable = (title: string, rows: any[]) => {
    lines.push(`${title}`);
    lines.push('');
    lines.push('| Calls | Total ms | Mean ms | Rows | Query |');
    lines.push('| ---: | ---: | ---: | ---: | --- |');
    for (const q of rows.slice(0, 10)) {
      const text = String(q.query).replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 220);
      lines.push(`| ${q.calls} | ${q.total_ms} | ${q.mean_ms} | ${q.rows} | \`${text}\` |`);
    }
    lines.push('');
  };
  pgTable('pg_stat_statements — top 10 by total time', r.pg.byTime);
  pgTable('pg_stat_statements — top 10 by calls', r.pg.byCalls);
  return lines.join('\n');
}

main()
  .catch((error: unknown) => {
    console.error('[load] run failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await teardown();
    process.exit(process.exitCode ?? 0);
  });
