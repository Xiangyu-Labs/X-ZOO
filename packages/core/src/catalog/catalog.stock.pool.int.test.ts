import {
  createDb,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_IDLE_IN_TX_TIMEOUT_MS,
  type Tx,
} from '@shop/db';
import { createTestCtx, forkTestCtx, type TestCtx } from '@shop/testing';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminActor, firstSkuId, makeAdmin, makeProduct } from './catalog.fixtures.repo';
import { catalogStockPort } from './catalog.stock';

/**
 * A stock reservation never needs a second pooled connection. STAB-001 found
 * why it matters:
 * `order.concurrency.int.test.ts > sells ten units to exactly ten of twelve buyers`
 * hung with one backend `idle in transaction` holding the SKU row lock and the
 * other eleven blocked on it — twelve connections, the harness pool's `max`.
 *
 * `catalogStockPort.reserve(tx, …, ctx)` takes the SKU row lock, then calls
 * `warnOnLowStock`, which reads `catalogConfig`. If that read is **not** on
 * `tx`, a cache miss takes a second connection from the pool, and with a
 * five-minute config TTL a miss is routine. With `max` transactions in flight
 * on one SKU, every connection is held by a transaction waiting on the lock;
 * the lock holder waits for a connection that can only come back when it
 * commits, and it never does.
 *
 * In production the web pool is `DB_POOL_MAX` 10. Ten checkouts of one SKU
 * landing in the same moment as a cache expiry would wedge the web process.
 * That is the flash-sale case the stock guard exists for.
 *
 * This file makes it deterministic with a pool of three and three reservers.
 * The holder's config-cache read is held until the other two are blocked on the
 * row lock, and every reservation must still finish.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';
const POOL_MAX = 3;
const APP_NAME = 'k2-pool-starvation';
const DEADLOCK_AFTER_MS = 8_000;

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  harness.clock.set(NOW);
});

/** Backends of the small pool that are blocked on a lock. */
async function blockedOnLock(): Promise<number> {
  const result = await harness.ctx.db.execute<{ n: string }>(
    sql`select count(*)::text as n from pg_stat_activity
        where datname = current_database() and application_name = ${APP_NAME}
          and wait_event_type = 'Lock'`,
  );
  return Number(result.rows[0]!.n);
}

/**
 * The harness's Redis, except that the first read of the catalog config cache
 * waits until `waiters` other reservers are blocked on the row lock. That is
 * the schedule a burst of checkouts produces by chance.
 */
function redisHoldingFirstConfigRead(redis: Redis, waiters: number): Redis {
  let armed = true;
  return new Proxy(redis, {
    get(target, prop) {
      if (prop === 'get') {
        return async (key: string) => {
          if (armed && key === 'config:catalog') {
            armed = false;
            const deadline = Date.now() + DEADLOCK_AFTER_MS;
            while ((await blockedOnLock()) < waiters && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
          return target.get(key);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

describe('a stock reservation never needs a second pooled connection', () => {
  it('lets pool-max reservers of one SKU all finish when the config cache is cold', async () => {
    const admin = harness.as(adminActor(await makeAdmin(harness)));
    const product = await makeProduct(admin);
    const skuId = await firstSkuId(harness, product.id);

    const url = new URL(harness.db.url);
    url.searchParams.set('application_name', APP_NAME);
    const small = createDb(url.toString(), { max: POOL_MAX });
    // The terminations below are ours; a pooled client reporting them is noise.
    small.pool.on('error', () => {});
    small.pool.on('connect', (client) => client.on('error', () => {}));
    const redis = redisHoldingFirstConfigRead(harness.redis, POOL_MAX - 1);
    const base = { ...harness, redis, db: { ...harness.db, db: small.db } } as TestCtx;

    const reservations = Array.from({ length: POOL_MAX }, (_, index) => {
      const ctx = forkTestCtx(base, { requestId: `reserve-${index}` });
      return ctx.withTx((tx) =>
        catalogStockPort.reserve(tx, 9000 + index, [{ skuId, quantity: 1 }], ctx),
      );
    });

    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      Promise.allSettled(reservations).then(() => 'finished' as const),
      new Promise<'wedged'>((resolve) => {
        timer = setTimeout(() => resolve('wedged'), DEADLOCK_AFTER_MS * 2);
      }),
    ]);
    clearTimeout(timer);

    // Free the wedged sessions either way, so the file can tear down.
    await harness.ctx.db.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity
          where datname = current_database() and application_name = ${APP_NAME}`,
    );
    await Promise.allSettled(reservations);
    await small.close().catch(() => {});

    expect(outcome).toBe('finished');
  });
});

/**
 * Defence in depth. Reading config on `tx` removes the one known second
 * connection; these two limits make the *next* one an error the caller sees,
 * instead of a process that stops serving.
 */
describe('a starved pool is an error, not a hang', () => {
  const lockSku = (tx: Tx, skuId: number) =>
    tx.execute(sql`update product_skus set stock = stock where id = ${skuId}`);

  it('bounds both waits by default: a 5 s acquire timeout and a 30 s idle-in-transaction timeout', async () => {
    const handle = createDb(harness.db.url, { max: 1 });
    try {
      const options = handle.pool.options as {
        connectionTimeoutMillis?: number;
        idle_in_transaction_session_timeout?: number;
      };
      expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBe(5_000);
      expect(DEFAULT_IDLE_IN_TX_TIMEOUT_MS).toBe(30_000);
      expect(options.connectionTimeoutMillis).toBe(DEFAULT_ACQUIRE_TIMEOUT_MS);
      expect(options.idle_in_transaction_session_timeout).toBe(DEFAULT_IDLE_IN_TX_TIMEOUT_MS);
      // …and the server really applies the second one to the session.
      const shown = await handle.db.execute<{ idle_in_transaction_session_timeout: string }>(
        sql`show idle_in_transaction_session_timeout`,
      );
      expect(shown.rows[0]!.idle_in_transaction_session_timeout).toBe('30s');
    } finally {
      await handle.close();
    }
  });

  it('fails the lock holder’s second acquire, rolls it back, and lets the waiter through', async () => {
    const admin = harness.as(adminActor(await makeAdmin(harness)));
    const product = await makeProduct(admin);
    const skuId = await firstSkuId(harness, product.id);

    const url = new URL(harness.db.url);
    url.searchParams.set('application_name', APP_NAME);
    // The same shape with nothing catalog-specific left: pool of two, one
    // transaction holds the row lock, the other waits on it, and the holder
    // asks the pool for another connection.
    const small = createDb(url.toString(), { max: 2, acquireTimeoutMs: 1_000 });
    const started = Date.now();
    try {
      let holderHasLock!: () => void;
      const locked = new Promise<void>((resolve) => (holderHasLock = resolve));

      const holder = small.db.transaction(async (tx) => {
        await lockSku(tx, skuId);
        holderHasLock();
        while ((await blockedOnLock()) < 1) await new Promise((r) => setTimeout(r, 25));
        await small.db.execute(sql`select 1`); // the second connection
      });
      await locked;
      const waiter = small.db.transaction((tx) => lockSku(tx, skuId));

      const [held, waited] = await Promise.allSettled([holder, waiter]);
      expect(held.status).toBe('rejected');
      // drizzle wraps the driver's error as "Failed query"; pg's is the cause.
      const reason = (held as PromiseRejectedResult).reason as Error;
      expect(String(reason.cause)).toMatch(/timeout exceeded when trying to connect/);
      expect(waited.status).toBe('fulfilled');
      expect(Date.now() - started).toBeLessThan(DEADLOCK_AFTER_MS);
    } finally {
      await harness.ctx.db.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity
          where datname = current_database() and application_name = ${APP_NAME}`,
      );
      await small.close().catch(() => {});
    }
  });

  it('has the server end a transaction left idle, releasing its lock, without crashing the process', async () => {
    const admin = harness.as(adminActor(await makeAdmin(harness)));
    const product = await makeProduct(admin);
    const skuId = await firstSkuId(harness, product.id);

    const reported: Error[] = [];
    const small = createDb(harness.db.url, {
      max: 1,
      idleInTransactionTimeoutMs: 300,
      onConnectionError: (error) => reported.push(error),
    });
    try {
      const abandoned = small.db.transaction(async (tx) => {
        await lockSku(tx, skuId);
        await new Promise((resolve) => setTimeout(resolve, 1_500)); // idle, holding the lock
        await tx.execute(sql`select 1`);
      });
      await expect(abandoned).rejects.toThrow();

      // The lock went with the session: another writer gets the row at once.
      await harness.ctx.withTx(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await lockSku(tx, skuId);
      });
      expect(reported.map((error) => error.message).join('\n')).toMatch(
        /idle-in-transaction timeout|terminat/i,
      );
      // The pool dropped the dead connection and serves the next caller.
      const next = await small.db.execute<{ one: number }>(sql`select 1 as one`);
      expect(next.rows[0]!.one).toBe(1);
    } finally {
      await small.close().catch(() => {});
    }
  });
});
