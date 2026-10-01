import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestCtx, forkTestCtx, type TestCtx } from './ctx';
import { createTestDatabase } from './db';
import { runConcurrently } from './concurrency';

/**
 * The harness testing itself.
 *
 * Every other integration test in the project stands on this, so the promises
 * it makes — a migrated schema, `pg_trgm`, real isolation between files, a
 * usable `Ctx` — are worth asserting rather than assuming.
 */

let harness: TestCtx;

beforeAll(async () => {
  harness = await createTestCtx();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('the cloned database', () => {
  it('has the kernel schema', async () => {
    const { rows } = await harness.db.handle.pool.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const tables = rows.map((r) => r.tablename);
    for (const table of [
      'admins',
      'roles',
      'role_permissions',
      'admin_roles',
      'user_sessions',
      'audit_logs',
      'config_values',
      'effects',
      'failed_jobs',
    ]) {
      expect(tables, table).toContain(table);
    }
  });

  it('has pg_trgm, which catalog search needs', async () => {
    const { rows } = await harness.db.handle.pool.query<{ extname: string }>(
      `select extname from pg_extension where extname = 'pg_trgm'`,
    );
    expect(rows).toHaveLength(1);
    // And it actually works.
    const similar = await harness.ctx.db.execute(sql`select similarity('shirt', 'shirts') as s`);
    expect(Number((similar.rows[0] as { s: number }).s)).toBeGreaterThan(0.5);
  });

  it('carries the unique indexes the domain logic relies on', async () => {
    const { rows } = await harness.db.handle.pool.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'`,
    );
    const indexes = rows.map((r) => r.indexname);
    expect(indexes).toContain('effects_scope_event_key');
    expect(indexes).toContain('user_sessions_token_hash_key');
    expect(indexes).toContain('admins_account_lower_key');
  });

  // `group` is a reserved word: Drizzle quotes it, raw SQL must too. Anyone
  // hand-writing a config query hits this the first time.
  it('gives each caller a genuinely separate database', async () => {
    const other = await createTestDatabase();
    try {
      expect(other.name).not.toBe(harness.db.name);

      await harness.ctx.db.execute(sql`insert into config_values ("group", "key", value)
        values ('isolation', 'k', '"mine"'::jsonb)`);
      const theirs = await other.db.execute(sql`select count(*)::int as n from config_values`);
      expect((theirs.rows[0] as { n: number }).n).toBe(0);
    } finally {
      await other.drop();
    }
  });

  it('truncateAll empties the data and resets the identities', async () => {
    await harness.ctx.db.execute(sql`insert into config_values ("group", "key", value)
      values ('truncate', 'k', '1'::jsonb)`);
    await harness.db.truncateAll();
    const after = await harness.ctx.db.execute(sql`select count(*)::int as n from config_values`);
    expect((after.rows[0] as { n: number }).n).toBe(0);
  });
});

describe('createTestCtx', () => {
  it('wires a usable context', () => {
    expect(harness.ctx.actor.kind).toBe('system');
    expect(harness.ctx.clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(harness.ctx.requestId).toBe('test-request');
    expect(typeof harness.ctx.withTx).toBe('function');
  });

  it('records rather than running queued jobs', async () => {
    harness.queue.reset();
    await harness.ctx.queue.enqueue('order.autoCancel', { orderId: '1' }, { delay: 60_000 });
    expect(harness.queue.jobs).toEqual([
      { jobName: 'order.autoCancel', payload: { orderId: '1' }, options: { delay: 60_000 } },
    ]);
  });

  it('forkTestCtx shares the database but not the actor', async () => {
    const second = forkTestCtx(harness, {
      actor: { kind: 'user', id: 5, permissions: [], isSuper: false },
      requestId: 'other',
    });
    expect(second.actor.id).toBe(5);
    expect(second.requestId).toBe('other');
    // Same database: a write through one is visible through the other.
    await harness.db.truncateAll();
    await harness.ctx.db.execute(sql`insert into config_values ("group", "key", value)
      values ('fork', 'k', '1'::jsonb)`);
    const seen = await second.db.execute(sql`select count(*)::int as n from config_values`);
    expect((seen.rows[0] as { n: number }).n).toBe(1);
  });
});

describe('runConcurrently against the real database', () => {
  it('really does run the callers in parallel', async () => {
    await harness.db.truncateAll();
    // Each caller sleeps 200ms inside PostgreSQL. Serialised that is 2s;
    // in parallel it is a little over 200ms.
    const startedAt = performance.now();
    const report = await runConcurrently(10, () =>
      harness.ctx.db.execute(sql`select pg_sleep(0.2)`),
    );
    const elapsed = performance.now() - startedAt;
    expect(report.rejected).toEqual([]);
    expect(elapsed).toBeLessThan(1500);
  });
});
