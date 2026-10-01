import { randomBytes } from 'node:crypto';
import { createDb, type Db, type DbHandle } from '@shop/db';
import pg from 'pg';
import Redis from 'ioredis';

/**
 * Per-test-file PostgreSQL and Redis.
 *
 * A database is *cloned* from the template built in `global-setup.ts`
 * (`CREATE DATABASE … TEMPLATE …`), so every file starts from the same
 * migrated, empty schema and can do whatever it likes — including committing
 * transactions, which a "wrap every test in a rollback" harness cannot support
 * and which every concurrency test in this project needs.
 *
 * Redis is isolated by logical database index, one per vitest worker, flushed
 * when the file starts.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set — integration tests must run through the @shop/testing globalSetup ` +
        `(vitest --project int)`,
    );
  }
  return value;
}

export function pgAdminUrl(): string {
  return requireEnv('SHOP_TEST_PG_URL');
}

export function redisUrl(): string {
  return requireEnv('SHOP_TEST_REDIS_URL');
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface TestDatabase {
  name: string;
  url: string;
  db: Db;
  handle: DbHandle;
  /** Truncates every table but keeps the schema. Cheaper than a re-clone. */
  truncateAll(): Promise<void>;
  drop(): Promise<void>;
}

/**
 * Clones the template into a fresh database. Call it once per test file from
 * `beforeAll`, and `drop()` from `afterAll`.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = pgAdminUrl();
  const template = process.env.SHOP_TEST_TEMPLATE ?? 'shop_template';
  const name = `shop_t_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  } finally {
    await admin.end();
  }

  const url = withDatabase(adminUrl, name);
  const handle = createDb(url, { max: 12 });

  return {
    name,
    url,
    db: handle.db,
    handle,
    async truncateAll() {
      const { rows } = await handle.pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public'`,
      );
      if (rows.length === 0) return;
      const list = rows.map((r) => `"${r.tablename}"`).join(', ');
      await handle.pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    },
    async drop() {
      await handle.close();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`,
          [name],
        );
        await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/**
 * A Redis client on this worker's own logical database, flushed on creation.
 *
 * Key prefixes would be tidier, but ioredis does not apply `keyPrefix` to the
 * KEYS of an `EVAL`, and the rate limiters are Lua — so a prefix would quietly
 * let two workers share a counter.
 */
export function createTestRedis(): Redis {
  const workerId = Number(process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 1);
  const index = Number.isFinite(workerId) ? Math.abs(workerId) % 16 : 0;
  return new Redis(redisUrl(), { db: index, maxRetriesPerRequest: null, lazyConnect: false });
}

export async function flushTestRedis(redis: Redis): Promise<void> {
  await redis.flushdb();
}
