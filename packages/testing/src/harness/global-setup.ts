import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import pg from 'pg';

/**
 * Vitest `globalSetup` for the integration project.
 *
 * Runs **once per vitest run**, before any worker is forked:
 *
 *  1. starts PostgreSQL 17 and Redis 7 in containers;
 *  2. creates one *template* database, installs `pg_trgm`, and applies the
 *     schema to it exactly once;
 *  3. publishes the connection URLs through `process.env`, which the forked
 *     workers inherit.
 *
 * Each test *file* then clones the template with `CREATE DATABASE … TEMPLATE …`
 * (see `db.ts`), which is a file copy inside PostgreSQL and costs tens of
 * milliseconds — far cheaper than re-running migrations, and it gives every
 * file a genuinely isolated database instead of a shared one with truncation
 * between tests.
 *
 * Set `SHOP_TEST_PG_URL` / `SHOP_TEST_REDIS_URL` to point at an already-running
 * pair and the containers are skipped. That is how a developer keeps a warm
 * stack between runs; CI always uses containers.
 */

const PG_IMAGE = process.env.SHOP_TEST_PG_IMAGE ?? 'postgres:17-alpine';
const REDIS_IMAGE = process.env.SHOP_TEST_REDIS_IMAGE ?? 'redis:7-alpine';

const PG_USER = 'shop';
const PG_PASSWORD = 'shop';
const PG_DATABASE = 'shop';
export const TEMPLATE_DATABASE = 'shop_template';

let pgContainer: StartedTestContainer | undefined;
let redisContainer: StartedTestContainer | undefined;

/** Where `packages/db` keeps its committed migrations, once they exist. */
function migrationsDir(): string {
  return path.resolve(import.meta.dirname, '../../../db/migrations');
}

/** Where `packages/db` keeps its schema files. */
function schemaDir(): string {
  return path.resolve(import.meta.dirname, '../../../db/src/schema');
}

async function startPostgres(): Promise<string> {
  if (process.env.SHOP_TEST_PG_URL) return process.env.SHOP_TEST_PG_URL;
  pgContainer = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DATABASE,
    })
    .withExposedPorts(5432)
    // `fsync=off` is safe: this database is thrown away at the end of the run,
    // and it roughly halves the cost of the integration suite.
    .withCommand([
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'max_connections=200',
    ])
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(180_000)
    .start();
  const port = pgContainer.getMappedPort(5432);
  return `postgres://${PG_USER}:${PG_PASSWORD}@${pgContainer.getHost()}:${port}/${PG_DATABASE}`;
}

async function startRedis(): Promise<string> {
  if (process.env.SHOP_TEST_REDIS_URL) return process.env.SHOP_TEST_REDIS_URL;
  redisContainer = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    // Production runs `noeviction`; tests must too, or a test that
    // fills Redis would pass here and fail in production.
    .withCommand(['redis-server', '--maxmemory-policy', 'noeviction', '--save', ''])
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(120_000)
    .start();
  return `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
}

/** Committed `.sql` migrations, in filename order. Empty until `0000_init` lands. */
async function readMigrations(): Promise<string[]> {
  try {
    const files = (await readdir(migrationsDir()))
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
    return Promise.all(files.map((f) => readFile(path.join(migrationsDir(), f), 'utf8')));
  } catch {
    return [];
  }
}

/**
 * No committed migration yet? Build the DDL straight from the schema files
 * with drizzle-kit's programmatic API — the same diff `drizzle-kit generate`
 * would write, but held in memory so nothing generated is ever committed.
 *
 * The moment `packages/db/migrations/0000_init.sql` exists this branch stops
 * being taken and the harness replays the real migrations instead.
 */
async function ddlFromSchema(): Promise<string[]> {
  const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');
  const files = (await readdir(schemaDir()))
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'))
    .sort((a, b) => a.localeCompare(b));

  const tables: Record<string, unknown> = {};
  for (const file of files) {
    const mod = (await import(path.join(schemaDir(), file))) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) tables[`${file}:${name}`] = value;
  }

  const empty = generateDrizzleJson({}, undefined, undefined, 'snake_case');
  const current = generateDrizzleJson(tables, empty.id, undefined, 'snake_case');
  return generateMigration(empty, current);
}

async function buildTemplate(pgUrl: string): Promise<void> {
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DATABASE}`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
  } finally {
    await admin.end();
  }

  const template = new pg.Client({ connectionString: templateUrl(pgUrl) });
  await template.connect();
  try {
    // Catalog search uses pg_trgm, so it must exist in the template.
    await template.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

    const migrations = await readMigrations();
    const statements =
      migrations.length > 0
        ? migrations.flatMap((sql) => sql.split('--> statement-breakpoint'))
        : await ddlFromSchema();

    for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed.length === 0) continue;
      await template.query(trimmed);
    }
    process.env.SHOP_TEST_SCHEMA_SOURCE = migrations.length > 0 ? 'migrations' : 'schema-diff';
  } finally {
    await template.end();
  }
}

export function templateUrl(pgUrl: string): string {
  const url = new URL(pgUrl);
  url.pathname = `/${TEMPLATE_DATABASE}`;
  return url.toString();
}

export async function setup(): Promise<void> {
  const started = Date.now();
  const [pgUrl, redisUrl] = await Promise.all([startPostgres(), startRedis()]);
  process.env.SHOP_TEST_PG_URL = pgUrl;
  process.env.SHOP_TEST_REDIS_URL = redisUrl;

  await buildTemplate(pgUrl);
  process.env.SHOP_TEST_TEMPLATE = TEMPLATE_DATABASE;

  console.log(
    `[harness] postgres + redis ready in ${Date.now() - started}ms ` +
      `(schema from ${process.env.SHOP_TEST_SCHEMA_SOURCE})`,
  );
}

export async function teardown(): Promise<void> {
  await Promise.allSettled([pgContainer?.stop(), redisContainer?.stop()]);
}
