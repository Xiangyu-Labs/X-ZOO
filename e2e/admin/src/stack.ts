import { readFile } from 'node:fs/promises';

import { createDb, type Db, type DbHandle } from '@shop/db';
import {
  createConfigService,
  createCtx,
  createLocalStorage,
  memoryQueue,
  silentLogger,
  systemActor,
  systemClock,
  type ConfigCache,
  type Ctx,
} from '@shop/core/kernel';
import Redis from 'ioredis';

import { STACK_FILE, type StackInfo } from './stack-file';

/**
 * A `Ctx` on the *same* database the server under test is using.
 *
 * Specs use it for two things only:
 *
 *  - **arranging** a fixture the admin UI cannot create by itself — a paid
 *    order, for instance, which in production is created by a WeChat callback;
 *  - **reading back** what the UI cannot show — the `audit_logs` row, the
 *    stored config value behind a masked field, the effect-ledger entry.
 *
 * It is never used to assert something the UI could have asserted. A spec that
 * checks the database instead of the screen is an integration test wearing a
 * browser, and those already exist in `packages/core`.
 *
 * Two deliberate differences from the server's own container:
 *
 *  - the queue is in memory, because no worker runs during the suite. Jobs the
 *    *server* schedules still go to the real BullMQ queue in Redis and stay
 *    there; specs assert the effect-ledger row, not the side effect.
 *  - the logger is silent: this process's job is to report test results.
 */

let cached: Promise<Stack> | undefined;

export interface Stack extends StackInfo {
  db: Db;
  handle: DbHandle;
  redis: Redis;
  /** Acts as `system`, which bypasses permission checks — seeding, not testing. */
  ctx: Ctx;
  close(): Promise<void>;
}

function asConfigCache(redis: Redis): ConfigCache {
  return {
    get: (key) => redis.get(key),
    set: (key, value, _mode, ttl) => redis.set(key, value, 'PX', ttl),
    del: (...keys) => redis.del(...keys),
    publish: (channel, message) => redis.publish(channel, message),
  };
}

/** Builds a Ctx against explicit connection strings. Shared with the seed. */
export function ctxFor(options: { databaseUrl: string; redisUrl: string; uploadsDir: string }): {
  ctx: Ctx;
  db: Db;
  handle: DbHandle;
  redis: Redis;
  close(): Promise<void>;
} {
  const handle = createDb(options.databaseUrl, { max: 5 });
  const redis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const clock = systemClock;
  const ctx = createCtx({
    db: handle.db,
    redis,
    clock,
    config: createConfigService({ db: handle.db, cache: asConfigCache(redis), clock }),
    logger: silentLogger(),
    queue: memoryQueue(),
    storage: createLocalStorage({
      root: options.uploadsDir,
      publicPrefix: '/uploads',
      now: () => clock.now(),
    }),
    actor: systemActor,
    platform: null,
    requestId: 'e2e',
  });
  return {
    ctx,
    db: handle.db,
    handle,
    redis,
    async close() {
      await handle.close();
      redis.disconnect();
    },
  };
}

async function open(): Promise<Stack> {
  let info: StackInfo;
  try {
    info = JSON.parse(await readFile(STACK_FILE, 'utf8')) as StackInfo;
  } catch (error) {
    throw new Error(
      `${STACK_FILE} is missing — the stack writes it as it starts. Run the suite with ` +
        `\`pnpm --filter @shop/e2e-admin e2e\`, which starts it.`,
      { cause: error },
    );
  }
  const parts = ctxFor(info);
  return { ...info, ...parts };
}

/** One connection pool for the whole run; Playwright's worker teardown closes it. */
export function stack(): Promise<Stack> {
  cached ??= open();
  return cached;
}

export async function closeStack(): Promise<void> {
  const open = cached;
  cached = undefined;
  if (open) await (await open).close();
}
