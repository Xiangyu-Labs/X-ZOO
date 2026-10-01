import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { effects } from '@shop/db/schema/system';
import { createTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import { conditionalDelete, conditionalUpdate, lockRow, lockRows, withTx } from './tx';

/**
 * The three moves every state change is built from, against a real PostgreSQL.
 *
 * The `effects` table stands in for "some row with a status" — it belongs to
 * the platform rather than to any one domain, and the mechanics are the ones
 * every domain will copy.
 */

let harness: TestCtx;

beforeAll(async () => {
  harness = await createTestCtx();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
});

async function seedEffect(scopeId: string, status = 'pending'): Promise<number> {
  const rows = await harness.ctx.db
    .insert(effects)
    .values({
      scope: 'test',
      scopeId,
      eventType: 'thing.happened',
      payload: {},
      status,
      nextRunAt: harness.clock.now(),
    })
    .returning({ id: effects.id });
  return rows[0]!.id;
}

describe('withTx', () => {
  it('commits the whole unit of work', async () => {
    await withTx(harness.ctx.db, async (tx) => {
      await tx.insert(effects).values({
        scope: 'test',
        scopeId: 'a',
        eventType: 'e',
        payload: {},
        nextRunAt: harness.clock.now(),
      });
      await tx.insert(effects).values({
        scope: 'test',
        scopeId: 'b',
        eventType: 'e',
        payload: {},
        nextRunAt: harness.clock.now(),
      });
    });
    const rows = await harness.ctx.db.select().from(effects);
    expect(rows).toHaveLength(2);
  });

  it('rolls everything back when the callback throws', async () => {
    await expect(
      withTx(harness.ctx.db, async (tx) => {
        await tx.insert(effects).values({
          scope: 'test',
          scopeId: 'a',
          eventType: 'e',
          payload: {},
          nextRunAt: harness.clock.now(),
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await harness.ctx.db.select().from(effects)).toHaveLength(0);
  });

  it('reuses an open transaction instead of opening a savepoint', async () => {
    let innerHandle: unknown;
    await withTx(harness.ctx.db, async (tx) => {
      await withTx(tx, async (inner) => {
        innerHandle = inner;
      });
      expect(innerHandle).toBe(tx);
    });
  });

  it('honours the isolation level', async () => {
    const level = await withTx(
      harness.ctx.db,
      async (tx) => {
        const result = await tx.execute(sql`show transaction_isolation`);
        return (result.rows[0] as { transaction_isolation: string }).transaction_isolation;
      },
      { isolationLevel: 'serializable' },
    );
    expect(level).toBe('serializable');
  });

  it('ctx.withTx is the same thing, bound to the request database', async () => {
    await harness.ctx.withTx(async (tx) => {
      await tx.insert(effects).values({
        scope: 'test',
        scopeId: 'via-ctx',
        eventType: 'e',
        payload: {},
        nextRunAt: harness.clock.now(),
      });
    });
    expect(await harness.ctx.db.select().from(effects)).toHaveLength(1);
  });
});

describe('lockRow', () => {
  it('returns the row it locked, and null for a row that is not there', async () => {
    const id = await seedEffect('lock-me');
    await withTx(harness.ctx.db, async (tx) => {
      const row = await lockRow(tx, effects, id);
      expect(row).toMatchObject({ scopeId: 'lock-me' });
      expect(await lockRow(tx, effects, id + 10_000)).toBeNull();
    });
  });

  it('serialises two transactions that lock the same row', async () => {
    const id = await seedEffect('serialise');
    const order: string[] = [];

    const first = withTx(harness.ctx.db, async (tx) => {
      await lockRow(tx, effects, id);
      order.push('first-locked');
      await new Promise((resolve) => setTimeout(resolve, 150));
      await tx.update(effects).set({ attempts: 1 }).where(eq(effects.id, id));
      order.push('first-done');
    });

    // Give the first transaction a head start, then contend for the same row.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = withTx(harness.ctx.db, async (tx) => {
      const row = await lockRow(tx, effects, id);
      order.push('second-locked');
      // Must observe the first transaction's committed write, not the old value.
      expect((row as { attempts: number }).attempts).toBe(1);
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first-locked', 'first-done', 'second-locked']);
  });

  it('skipLocked steps over a row somebody else holds', async () => {
    const id = await seedEffect('skip');
    let released!: () => void;
    const hold = new Promise<void>((resolve) => {
      released = resolve;
    });

    const holder = withTx(harness.ctx.db, async (tx) => {
      await lockRow(tx, effects, id);
      await hold;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const skipped = await withTx(harness.ctx.db, (tx) =>
      lockRow(tx, effects, id, { skipLocked: true }),
    );
    expect(skipped).toBeNull();

    released();
    await holder;
  });

  it('lockRows locks several in ascending id order', async () => {
    const a = await seedEffect('a');
    const b = await seedEffect('b');
    await withTx(harness.ctx.db, async (tx) => {
      const rows = await lockRows(tx, effects, [b, a]);
      expect(rows.map((r) => r.id)).toEqual([a, b]);
    });
    expect(await withTx(harness.ctx.db, (tx) => lockRows(tx, effects, []))).toEqual([]);
  });
});

describe('conditionalUpdate', () => {
  it('reports the affected row count', async () => {
    const id = await seedEffect('cond');
    const hit = await conditionalUpdate(harness.ctx.db, effects, {
      where: and(eq(effects.id, id), eq(effects.status, 'pending')),
      set: { status: 'done' },
    });
    expect(hit).toEqual({ affected: 1, won: true });

    // The guard no longer holds, so the second attempt changes nothing.
    const miss = await conditionalUpdate(harness.ctx.db, effects, {
      where: and(eq(effects.id, id), eq(effects.status, 'pending')),
      set: { status: 'unknown' },
    });
    expect(miss).toEqual({ affected: 0, won: false });

    const [row] = await harness.ctx.db.select().from(effects).where(eq(effects.id, id));
    expect(row?.status).toBe('done');
  });

  it('EXACTLY ONE of N concurrent conditional updates wins', async () => {
    // The invariant the whole system rests on: `docs/conventions.md` forbids
    // read-then-write on status, stock, seats and counters precisely because
    // this is what happens when twenty callers arrive at once.
    for (let round = 0; round < 5; round += 1) {
      const id = await seedEffect(`race-${round}`);
      const report = await runConcurrently(
        20,
        () =>
          conditionalUpdate(harness.ctx.db, effects, {
            where: and(eq(effects.id, id), eq(effects.status, 'pending')),
            set: { status: 'done' },
          }),
        { isWinner: (result) => result.won },
      );

      expect(report.rejected, `round ${round}`).toEqual([]);
      expect(report.winners, `round ${round}`).toBe(1);
      expect(report.losers, `round ${round}`).toBe(19);
    }
  });

  it('a counter incremented conditionally never over- or under-counts', async () => {
    const id = await seedEffect('counter');
    const report = await runConcurrently(
      30,
      () =>
        conditionalUpdate(harness.ctx.db, effects, {
          where: and(eq(effects.id, id), sql`${effects.attempts} < 10`),
          set: { attempts: sql`${effects.attempts} + 1` },
        }),
      { isWinner: (result) => result.won },
    );
    expect(report.rejected).toEqual([]);
    const [row] = await harness.ctx.db.select().from(effects).where(eq(effects.id, id));
    // The guard caps it at 10 — no caller can push it past the limit, which is
    // the "last seat" and "last item in stock" shape.
    expect(row?.attempts).toBe(10);
    expect(report.winners).toBe(10);
  });

  it('conditionalDelete works the same way', async () => {
    const id = await seedEffect('delete-me');
    const report = await runConcurrently(
      8,
      () => conditionalDelete(harness.ctx.db, effects, eq(effects.id, id)),
      { isWinner: (result) => result.won },
    );
    expect(report.winners).toBe(1);
    expect(await harness.ctx.db.select().from(effects)).toHaveLength(0);
  });
});

describe('runConcurrently', () => {
  it('releases every worker at the same moment', async () => {
    const startedAt: number[] = [];
    await runConcurrently(10, async () => {
      startedAt.push(performance.now());
      return true;
    });
    const spread = Math.max(...startedAt) - Math.min(...startedAt);
    expect(spread).toBeLessThan(50);
  });

  it('reports rejections as data rather than throwing', async () => {
    const report = await runConcurrently(4, async (index) => {
      if (index % 2 === 0) throw new Error(`no ${index}`);
      return index;
    });
    expect(report.fulfilled).toHaveLength(2);
    expect(report.rejected).toHaveLength(2);
    expect(report.results.every((r) => r.durationMs >= 0)).toBe(true);
  });

  it('refuses a nonsensical worker count', async () => {
    await expect(runConcurrently(0, async () => 1)).rejects.toThrow(RangeError);
  });
});
