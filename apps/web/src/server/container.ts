import { createDb, type Db, type DbOptions, type DbHandle } from '@shop/db';
import {
  createConfigService,
  createLocalStorage,
  createLogger,
  systemClock,
  type Clock,
  type ConfigCache,
  type ConfigService,
  type JobQueue,
  type Logger,
  type Storage,
} from '@shop/core/kernel';
import { createBullQueue } from '@shop/core/kernel/queue-bullmq';
import { AdminAuthService, UserSessionService } from '@shop/core/auth';
import { fakeSmsSender, registerSmsSender } from '@shop/core/sms';
import Redis from 'ioredis';
import { loadEnv, type Env } from './env';

/**
 * Process-wide singletons.
 *
 * Next.js re-evaluates route modules a lot in development; a connection pool
 * per evaluation exhausts PostgreSQL in about a minute. The container is
 * therefore memoised on `globalThis`, which is the only thing that survives a
 * hot reload.
 *
 * Nothing here is imported by `packages/core`: services take the pieces they
 * need through `Ctx`, so a test builds its own container and never has to
 * monkey-patch this module.
 */

export interface Container {
  env: Env;
  dbHandle: DbHandle;
  db: Db;
  redis: Redis;
  clock: Clock;
  logger: Logger;
  queue: JobQueue;
  storage: Storage;
  config: ConfigService;
  adminAuth: AdminAuthService;
  userSessions: UserSessionService;
  close(): Promise<void>;
}

const CONTAINER_KEY = Symbol.for('shop.web.container');

type GlobalWithContainer = typeof globalThis & { [CONTAINER_KEY]?: Container };

function asConfigCache(redis: Redis): ConfigCache {
  return {
    get: (key) => redis.get(key),
    set: (key, value, _mode, ttl) => redis.set(key, value, 'PX', ttl),
    del: (...keys) => redis.del(...keys),
    publish: (channel, message) => redis.publish(channel, message),
  };
}

let fakeSmsAnnounced = false;

/**
 * `SHOP_FAKE_SMS=1`: register the in-memory SMS sender in this
 * process's own module graph, so `POST /api/v1/auth/sms-codes` succeeds and
 * the code is only ever in Redis. Logged at `warn` once per process — a box
 * that has it on by mistake says so at boot, not when a shopper complains.
 *
 * Deliberately not a value of the `sms` config group; see `env.ts`.
 */
export function applyProcessOverrides(env: Env, logger: Pick<Logger, 'warn'>): void {
  if (env.SHOP_FAKE_SMS !== '1') return;
  registerSmsSender(fakeSmsSender());
  if (fakeSmsAnnounced) return;
  fakeSmsAnnounced = true;
  logger.warn({ env: 'SHOP_FAKE_SMS' }, 'fake SMS sender active — codes are not delivered');
}

/** Test helper: let the next `applyProcessOverrides` warn again. */
export function resetProcessOverrides(): void {
  fakeSmsAnnounced = false;
}

/**
 * The web process's pool options. Acquire and idle-in-transaction timeouts
 * come from `createDb`'s defaults (`DB_POOL_ACQUIRE_TIMEOUT_MS`,
 * `DB_IDLE_IN_TX_TIMEOUT_MS`). A connection the server ends while it
 * sits in the pool is logged, as the worker does, instead of vanishing.
 */
export function webDbOptions(env: Env, logger: Pick<Logger, 'warn'>): DbOptions {
  return {
    max: env.DB_POOL_MAX,
    onConnectionError: (err) => logger.warn({ err }, 'database connection ended outside a query'),
  };
}

export function buildContainer(env: Env = loadEnv()): Container {
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
  const dbHandle = createDb(env.DATABASE_URL, webDbOptions(env, logger));
  const redis = new Redis(env.REDIS_URL, {
    // BullMQ requires this, and a request that is waiting on Redis should fail
    // fast rather than retry behind the user's back.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  const clock = systemClock;
  const queue = createBullQueue({ connection: redis, queueName: env.QUEUE_NAME });
  const storage = createLocalStorage({
    root: env.UPLOADS_DIR,
    publicPrefix: env.UPLOADS_PUBLIC_PREFIX,
    now: () => clock.now(),
  });
  const config = createConfigService({ db: dbHandle.db, cache: asConfigCache(redis), clock });
  applyProcessOverrides(env, logger);

  return {
    env,
    dbHandle,
    db: dbHandle.db,
    redis,
    clock,
    logger,
    queue,
    storage,
    config,
    adminAuth: new AdminAuthService({ redis }),
    userSessions: new UserSessionService(),
    async close() {
      await dbHandle.close();
      redis.disconnect();
    },
  };
}

/** The memoised container. Every route handler goes through this. */
export function getContainer(): Container {
  const global = globalThis as GlobalWithContainer;
  const existing = global[CONTAINER_KEY];
  if (existing) return existing;
  const container = buildContainer();
  global[CONTAINER_KEY] = container;
  return container;
}

/** Test helper: install a container built by the harness. */
export function setContainer(container: Container | undefined): void {
  const global = globalThis as GlobalWithContainer;
  if (container === undefined) delete global[CONTAINER_KEY];
  else global[CONTAINER_KEY] = container;
}
