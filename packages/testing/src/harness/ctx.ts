import {
  createConfigService,
  createCtx,
  fixedClock,
  memoryQueue,
  memoryStorage,
  silentLogger,
  systemActor,
  type Actor,
  type ConfigCache,
  type Ctx,
  type FixedClock,
  type JobQueue,
  type Storage,
} from '@shop/core/kernel';
import type Redis from 'ioredis';
import { createTestDatabase, createTestRedis, flushTestRedis, type TestDatabase } from './db';

/**
 * A real `Ctx` on a real database, for integration tests.
 *
 * The clock is fixed so expiry tests never sleep; the queue records instead of
 * running, so a test asserts *that* a job was scheduled; storage is in memory.
 * Everything else — PostgreSQL, Redis, the config service — is the production
 * code path.
 */

export interface TestCtx {
  ctx: Ctx;
  db: TestDatabase;
  redis: Redis;
  clock: FixedClock;
  queue: ReturnType<typeof memoryQueue>;
  storage: Storage;
  /** Swap the actor without rebuilding anything. */
  as(actor: Actor): Ctx;
  close(): Promise<void>;
}

export interface CreateTestCtxOptions {
  actor?: Actor;
  now?: string | Date | number;
  platform?: Ctx['platform'];
  requestId?: string;
  queue?: JobQueue;
  storage?: Storage;
}

/** ioredis satisfies `ConfigCache`, but only after we narrow the overloads. */
function asConfigCache(redis: Redis): ConfigCache {
  return {
    get: (key) => redis.get(key),
    set: (key, value, _mode, ttl) => redis.set(key, value, 'PX', ttl),
    del: (...keys) => redis.del(...keys),
    publish: (channel, message) => redis.publish(channel, message),
  };
}

export async function createTestCtx(options: CreateTestCtxOptions = {}): Promise<TestCtx> {
  const db = await createTestDatabase();
  const redis = createTestRedis();
  await flushTestRedis(redis);

  const clock = fixedClock(options.now ?? '2026-01-01T00:00:00.000Z');
  const queue = options.queue ? (options.queue as ReturnType<typeof memoryQueue>) : memoryQueue();
  const storage = options.storage ?? memoryStorage(() => clock.now());
  const config = createConfigService({ db: db.db, cache: asConfigCache(redis), clock });

  const ctx = createCtx({
    db: db.db,
    redis,
    clock,
    config,
    logger: silentLogger(),
    queue,
    storage,
    actor: options.actor ?? systemActor,
    platform: options.platform ?? null,
    requestId: options.requestId ?? 'test-request',
  });

  return {
    ctx,
    db,
    redis,
    clock,
    queue,
    storage,
    as: (actor) => ctx.as(actor),
    async close() {
      redis.disconnect();
      await db.drop();
    },
  };
}

/**
 * A second, independent `Ctx` on the *same* database and Redis. This is what a
 * two-process concurrency test needs: separate connection pools, so the two
 * callers really do contend on PostgreSQL rather than sharing a session.
 */
export function forkTestCtx(base: TestCtx, options: CreateTestCtxOptions = {}): Ctx {
  return createCtx({
    db: base.db.db,
    redis: base.redis,
    clock: base.clock,
    config: createConfigService({
      db: base.db.db,
      cache: asConfigCache(base.redis),
      clock: base.clock,
    }),
    logger: silentLogger(),
    queue: options.queue ?? base.queue,
    storage: options.storage ?? base.storage,
    actor: options.actor ?? systemActor,
    platform: options.platform ?? null,
    requestId: options.requestId ?? 'test-request-2',
  });
}
