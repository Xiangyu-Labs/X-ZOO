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
 * A `Ctx` on the *same* database and Redis the server and worker under test are
 * using — the storefront analogue of `@shop/e2e-admin`'s `src/stack.ts`.
 *
 * Specs use it for exactly two things:
 *
 *  - **arranging** a fixture the storefront cannot create through its own UI —
 *    a paid group-buy team, a shipped order before the ship journey runs, or a
 *    second shopper's address;
 *  - **reading back** what the UI cannot show — the effect ledger, a job's
 *    presence in Redis, a row in a table no screen renders.
 *
 * The queue here is in-memory, exactly like the admin harness: it is never used
 * to run jobs (the real worker process, started by `scripts/serve.ts`, does
 * that against the real BullMQ queue in the same Redis), only to build a `Ctx`
 * that does not need its own queue connection.
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
        `\`pnpm --filter @shop/e2e-storefront test\`, which starts it.`,
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
