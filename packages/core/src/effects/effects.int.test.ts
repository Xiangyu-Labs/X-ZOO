import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { effects as effectsTable } from '@shop/db/schema/system';
import { createTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import { SummarizedError } from '../kernel/error-summary';
import { DomainError } from '../kernel/errors';
import { withTx } from '../kernel/tx';
import type { EffectInput, EffectKey } from './index';
import {
  countParkedEffects,
  dispatchDueEffects,
  dispatchEffectsOnce,
  drainEffects,
  effectsBacklogMs,
  findEffect,
  findEffectById,
  listEffects,
  listEffectsByStatus,
  pruneEffects,
  recordEffect,
  registerEffectHandler,
  registeredEffectTypes,
  resetEffectHandlers,
  retryEffect,
} from './index';

let harness: TestCtx;

beforeAll(async () => {
  harness = await createTestCtx();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  resetEffectHandlers();
});

afterEach(() => {
  resetEffectHandlers();
});

const key: EffectKey = { scope: 'order', scopeId: '1', eventType: 'order.paid' };

async function record(overrides: Partial<EffectInput> = {}) {
  return withTx(harness.ctx.db, (tx) =>
    recordEffect(tx, harness.ctx, { ...key, payload: { hello: 'world' }, ...overrides }),
  );
}

describe('recordEffect', () => {
  it('writes one row inside the caller transaction', async () => {
    expect(await record()).toBe(true);
    const row = await findEffect(harness.ctx.db, key);
    expect(row).toMatchObject({ scope: 'order', eventType: 'order.paid', status: 'pending' });
    expect(row?.payload).toEqual({ hello: 'world' });
  });

  it('is a no-op the second time — UNIQUE(scope, scope_id, event_type)', async () => {
    expect(await record()).toBe(true);
    expect(await record({ payload: { different: true } })).toBe(false);
    expect(await listEffectsByStatus(harness.ctx.db, 'pending')).toHaveLength(1);
  });

  it('is rolled back with the state change it belongs to', async () => {
    await expect(
      withTx(harness.ctx.db, async (tx) => {
        await recordEffect(tx, harness.ctx, { ...key, payload: {} });
        throw new Error('the state change failed');
      }),
    ).rejects.toThrow();
    expect(await findEffect(harness.ctx.db, key)).toBeNull();
  });

  it('records the same event for different aggregates independently', async () => {
    await record({ scopeId: '1' });
    await record({ scopeId: '2' });
    expect(await listEffectsByStatus(harness.ctx.db, 'pending')).toHaveLength(2);
  });

  it('honours a delay', async () => {
    await record({ delayMs: 60_000 });
    const report = await dispatchEffectsOnce(harness.ctx);
    expect(report.claimed).toBe(0);

    harness.clock.advance(61_000);
    registerEffectHandler('order', 'order.paid', async () => {});
    expect((await dispatchEffectsOnce(harness.ctx)).done).toBe(1);
  });
});

describe('the dispatcher', () => {
  it('runs the registered handler and marks the row done', async () => {
    const seen: unknown[] = [];
    registerEffectHandler('order', 'order.paid', async (_ctx, effect) => {
      seen.push(effect);
    });
    await record();

    const report = await dispatchEffectsOnce(harness.ctx);
    expect(report).toEqual({ claimed: 1, done: 1, retried: 0, parked: 0 });
    expect(seen[0]).toMatchObject({ scope: 'order', scopeId: '1', attempts: 1 });
    expect((await findEffect(harness.ctx.db, key))?.status).toBe('done');
  });

  it('does not pick a done row up again', async () => {
    registerEffectHandler('order', 'order.paid', async () => {});
    await record();
    await dispatchEffectsOnce(harness.ctx);
    expect((await dispatchEffectsOnce(harness.ctx)).claimed).toBe(0);
  });

  it('runs the handler EXACTLY ONCE under two concurrent dispatchers', async () => {
    // FOR UPDATE SKIP LOCKED plus the lease is the whole guarantee. If either
    // is wrong, a "notify WeChat" handler fires twice.
    let runs = 0;
    registerEffectHandler('order', 'order.paid', async () => {
      runs += 1;
      // Long enough that the second dispatcher is definitely inside its claim.
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    for (let i = 1; i <= 8; i += 1) await record({ scopeId: String(i) });

    const report = await runConcurrently(2, () =>
      dispatchEffectsOnce(harness.ctx, { batchSize: 8 }),
    );
    expect(report.rejected).toEqual([]);

    expect(runs).toBe(8);
    const claimed = report.fulfilled.reduce((sum, r) => sum + r.claimed, 0);
    expect(claimed).toBe(8);
    expect(await listEffectsByStatus(harness.ctx.db, 'done')).toHaveLength(8);
  });

  it('never claims a row another dispatcher is still holding', async () => {
    registerEffectHandler('order', 'order.paid', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await record();

    const slow = dispatchEffectsOnce(harness.ctx, { leaseMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const overlapping = await dispatchEffectsOnce(harness.ctx, { leaseMs: 60_000 });
    expect(overlapping.claimed).toBe(0);
    await slow;
  });

  it('retries with exponential backoff when a handler throws', async () => {
    let attempts = 0;
    registerEffectHandler('order', 'order.paid', async () => {
      attempts += 1;
      throw new Error('the gateway said no');
    });
    await record();

    const first = await dispatchEffectsOnce(harness.ctx, { baseBackoffMs: 1000 });
    expect(first).toMatchObject({ claimed: 1, done: 0, retried: 1, parked: 0 });

    const row = await findEffect(harness.ctx.db, key);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('the gateway said no');
    // A plain Error says nothing staff can read; the console shows a generic line.
    expect(row?.lastErrorSummary).toBeNull();
    // First retry is one base delay out.
    expect(row!.nextRunAt.getTime()).toBe(harness.clock.nowMs() + 1000);

    // Not due yet.
    expect((await dispatchEffectsOnce(harness.ctx, { baseBackoffMs: 1000 })).claimed).toBe(0);

    harness.clock.advance(1000);
    await dispatchEffectsOnce(harness.ctx, { baseBackoffMs: 1000 });
    const second = await findEffect(harness.ctx.db, key);
    expect(second?.attempts).toBe(2);
    // Second retry is twice as far out.
    expect(second!.nextRunAt.getTime()).toBe(harness.clock.nowMs() + 2000);
    expect(attempts).toBe(2);
  });

  it('succeeds on a later attempt and stops retrying', async () => {
    let attempts = 0;
    registerEffectHandler('order', 'order.paid', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('not yet');
    });
    await record();

    const report = await drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });
    expect(report.done).toBe(1);
    expect(attempts).toBe(3);
    const done = await findEffect(harness.ctx.db, key);
    expect(done).toMatchObject({ status: 'done', lastError: null, lastErrorSummary: null });
  });

  it('records the Chinese line an error carries next to its raw text', async () => {
    registerEffectHandler('order', 'order.paid', async (_ctx, effect) => {
      if (effect.attempts === 1) {
        throw new SummarizedError('wechat 47003: argument invalid', '字段内容不符合模板要求');
      }
      throw new DomainError('PAYMENT_NOT_CONFIGURED');
    });
    await record();

    await dispatchEffectsOnce(harness.ctx, { baseBackoffMs: 0 });
    expect(await findEffect(harness.ctx.db, key)).toMatchObject({
      lastError: 'wechat 47003: argument invalid',
      lastErrorSummary: '字段内容不符合模板要求',
    });

    // A DomainError's message is the registry's Chinese.
    await dispatchEffectsOnce(harness.ctx, { baseBackoffMs: 0 });
    expect((await findEffect(harness.ctx.db, key))?.lastErrorSummary).toBe(
      '支付尚未配置，请联系管理员',
    );
  });

  it('parks a row as unknown after max attempts, for a human to look at', async () => {
    registerEffectHandler('order', 'order.paid', async () => {
      throw new Error('permanently broken');
    });
    await record();

    const report = await drainEffects(harness.ctx, {
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
    });
    expect(report.parked).toBe(1);

    const row = await findEffect(harness.ctx.db, key);
    expect(row?.status).toBe('unknown');
    expect(row?.attempts).toBe(3);
    expect(row?.lastError).toContain('permanently broken');
    expect(await listEffectsByStatus(harness.ctx.db, 'unknown')).toHaveLength(1);

    // A parked row is never picked up again.
    expect((await dispatchEffectsOnce(harness.ctx)).claimed).toBe(0);
  });

  it('retries, then parks, an event whose handler was never deployed', async () => {
    await record();
    const report = await drainEffects(harness.ctx, {
      maxAttempts: 2,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
    });
    expect(report.parked).toBe(1);
    const parked = await findEffect(harness.ctx.db, key);
    expect(parked?.lastError).toContain('no handler');
    expect(parked?.lastErrorSummary).toBe(
      '后台程序里没有这类任务的处理逻辑，请联系技术人员查看服务器日志',
    );
  });

  it('truncates a giant error message rather than storing a novel', async () => {
    registerEffectHandler('order', 'order.paid', async () => {
      throw new Error('x'.repeat(5000));
    });
    await record();
    await dispatchEffectsOnce(harness.ctx);
    expect((await findEffect(harness.ctx.db, key))?.lastError?.length).toBe(500);
  });

  it('one failing handler does not stop the rest of the batch', async () => {
    registerEffectHandler('order', 'order.paid', async (_ctx, effect) => {
      if (effect.scopeId === '2') throw new Error('just this one');
    });
    for (let i = 1; i <= 4; i += 1) await record({ scopeId: String(i) });

    const report = await dispatchEffectsOnce(harness.ctx);
    expect(report).toMatchObject({ claimed: 4, done: 3, retried: 1 });
  });

  it('respects the batch size', async () => {
    registerEffectHandler('order', 'order.paid', async () => {});
    for (let i = 1; i <= 10; i += 1) await record({ scopeId: String(i) });
    expect((await dispatchEffectsOnce(harness.ctx, { batchSize: 3 })).claimed).toBe(3);
  });
});

describe('a dispatcher run drains while there is work', () => {
  const T0 = '2026-06-01T00:00:00.000Z';

  async function queue(count: number, delayMs?: number) {
    for (let i = 0; i < count; i += 1) {
      await record({ scopeId: `run-${i}`, ...(delayMs === undefined ? {} : { delayMs }) });
    }
  }

  it('leaves nothing due after one run, however many batches were queued', async () => {
    harness.clock.set(T0);
    const handled: string[] = [];
    registerEffectHandler('order', 'order.paid', async (_ctx, effect) => {
      handled.push(effect.scopeId);
    });
    await queue(17);

    const report = await dispatchDueEffects(harness.ctx, { batchSize: 5 });

    // Three full batches, then a short one that says the queue is empty.
    expect(report).toMatchObject({ claimed: 17, done: 17, passes: 4, oldestDueAgeMs: null });
    expect(new Set(handled).size).toBe(17);
    expect(await listEffectsByStatus(harness.ctx.db, 'pending')).toHaveLength(0);
  });

  it('stops claiming once the time budget is spent, and reports how late the rest are', async () => {
    harness.clock.set(T0);
    registerEffectHandler('order', 'order.paid', async () => {
      harness.clock.advance(1_000); // a slow handler, on the fake clock
    });
    await queue(20);

    const report = await dispatchDueEffects(harness.ctx, { batchSize: 5, budgetMs: 4_000 });

    // The first batch took 5 s of fake time: past the budget, so no second claim.
    expect(report).toMatchObject({ claimed: 5, done: 5, passes: 1 });
    expect(await listEffectsByStatus(harness.ctx.db, 'pending')).toHaveLength(15);
    // The fifteen left have been due since T0, and it is now T0 + 5 s.
    expect(report.oldestDueAgeMs).toBe(5_000);
  });

  it('counts neither a future row nor one under a dispatcher’s lease as waiting', async () => {
    harness.clock.set(T0);
    await queue(1, 60_000);
    expect(await effectsBacklogMs(harness.ctx)).toBeNull();

    await record({ scopeId: 'leased' });
    harness.clock.advance(2_000);
    expect(await effectsBacklogMs(harness.ctx)).toBe(2_000);
    // A claim pushes the row past its lease: it is being worked on, not waiting.
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    registerEffectHandler('order', 'order.paid', async () => {
      started();
      await hold;
    });
    const run = dispatchEffectsOnce(harness.ctx, { batchSize: 1 });
    await running;
    expect(await effectsBacklogMs(harness.ctx)).toBeNull();
    release();
    await run;
  });

  it('is bounded by maxPasses even when the clock never moves', async () => {
    harness.clock.set(T0);
    registerEffectHandler('order', 'order.paid', async () => {});
    await queue(12);
    const report = await dispatchDueEffects(harness.ctx, { batchSize: 2, maxPasses: 3 });
    expect(report).toMatchObject({ claimed: 6, passes: 3 });
    expect(report.oldestDueAgeMs).toBe(0);
  });
});

describe('the handler registry', () => {
  it('is keyed by scope and event type', () => {
    registerEffectHandler('order', 'order.paid', async () => {});
    registerEffectHandler('refund', 'refund.approved', async () => {});
    expect(registeredEffectTypes()).toEqual(['order/order.paid', 'refund/refund.approved']);
  });
});

describe('claim ordering', () => {
  it('takes the oldest due rows first', async () => {
    const handled: string[] = [];
    registerEffectHandler('order', 'order.paid', async (_ctx, effect) => {
      handled.push(effect.scopeId);
    });
    await record({ scopeId: 'late', delayMs: 1000 });
    await record({ scopeId: 'early' });
    harness.clock.advance(2000);

    await dispatchEffectsOnce(harness.ctx, { batchSize: 1 });
    expect(handled).toEqual(['early']);

    // Sanity: the row really is the one we think it is.
    const early = await harness.ctx.db
      .select()
      .from(effectsTable)
      .where(eq(effectsTable.scopeId, 'early'));
    expect(early[0]?.status).toBe('done');
  });
});

/**
 * The operator console.
 *
 * The read side is a screen; the write side is the only thing in the admin that
 * can make a third-party call happen a second time, so it is a conditional
 * update and the test that matters is the race.
 */
describe('listEffects', () => {
  const page = { page: 1, pageSize: 20 };

  async function parked(scopeId: string, eventType = 'order.paid'): Promise<void> {
    await record({ scopeId, eventType });
    await drainEffects(harness.ctx, { maxAttempts: 1, baseBackoffMs: 0, maxBackoffMs: 0 });
  }

  it('filters by status, scope and event type', async () => {
    await record({ scopeId: '1' });
    await record({ scope: 'refund', scopeId: '2', eventType: 'refund.approved' });
    await record({ scope: 'user', scopeId: '3', eventType: 'user.registered' });

    const all = await listEffects(harness.ctx.db, { status: 'pending', ...page });
    expect(all.total).toBe(3);

    const oneScope = await listEffects(harness.ctx.db, {
      status: 'pending',
      scope: 'refund',
      ...page,
    });
    expect(oneScope.rows.map((row) => row.scopeId)).toEqual(['2']);

    const oneType = await listEffects(harness.ctx.db, {
      status: 'pending',
      eventType: 'order.paid',
      ...page,
    });
    expect(oneType.rows.map((row) => row.scopeId)).toEqual(['1']);

    // Nothing is parked yet, so the console's default screen is empty.
    expect((await listEffects(harness.ctx.db, { status: 'unknown', ...page })).total).toBe(0);
  });

  it('honours the caller scope allow-list, and never widens it', async () => {
    await record({ scopeId: '1' });
    await record({ scope: 'user', scopeId: '3', eventType: 'user.registered' });
    const scopes = ['order', 'refund'] as const;

    const allowed = await listEffects(harness.ctx.db, { status: 'pending', scopes, ...page });
    expect(allowed.rows.map((row) => row.scope)).toEqual(['order']);
    expect(allowed.total).toBe(1);

    // Asking for a scope outside the list is not a way around the list.
    const sneaky = await listEffects(harness.ctx.db, {
      status: 'pending',
      scopes,
      scope: 'user',
      ...page,
    });
    expect(sneaky.rows).toEqual([]);
    expect(sneaky.total).toBe(0);
  });

  it('narrows by a scope-id prefix, taken literally', async () => {
    await record({ scope: 'notification', scopeId: 'order_paid:order:1', eventType: 'send' });
    await record({ scope: 'notification', scopeId: 'order_paid_admin:order:1', eventType: 'send' });
    await record({ scope: 'notification', scopeId: 'orderXpaid:order:2', eventType: 'send' });

    const { rows, total } = await listEffects(harness.ctx.db, {
      status: 'pending',
      scopeIdPrefix: 'order_paid:',
      ...page,
    });
    // `_` is a LIKE wildcard; unescaped it would also match `orderXpaid:`.
    expect(rows.map((row) => row.scopeId)).toEqual(['order_paid:order:1']);
    expect(total).toBe(1);

    const percent = await listEffects(harness.ctx.db, {
      status: 'pending',
      scopeIdPrefix: '%',
      ...page,
    });
    expect(percent.total).toBe(0);
  });

  it('leaves the payload out unless the caller asks for it', async () => {
    await record({ scopeId: '1' });

    const plain = await listEffects(harness.ctx.db, { status: 'pending', ...page });
    expect(plain.rows[0]).not.toHaveProperty('payload');

    const detailed = await listEffects(harness.ctx.db, {
      status: 'pending',
      withPayload: true,
      ...page,
    });
    expect(detailed.rows[0]?.payload).toEqual({ hello: 'world' });
  });

  it('puts what changed most recently first, and pages', async () => {
    for (const scopeId of ['1', '2', '3']) {
      await record({ scopeId });
      harness.clock.advance(1000);
    }

    const first = await listEffects(harness.ctx.db, { status: 'pending', page: 1, pageSize: 2 });
    expect(first.rows.map((row) => row.scopeId)).toEqual(['3', '2']);
    expect(first.total).toBe(3);

    const second = await listEffects(harness.ctx.db, { status: 'pending', page: 2, pageSize: 2 });
    expect(second.rows.map((row) => row.scopeId)).toEqual(['1']);
    expect(second.total).toBe(3);
  });

  it('carries both timestamps, because "parked when?" is the triage question', async () => {
    const createdAt = harness.clock.nowMs();
    await parked('1');
    harness.clock.advance(60_000);

    const { rows } = await listEffects(harness.ctx.db, { status: 'unknown', ...page });
    expect(rows[0]?.createdAt.getTime()).toBe(createdAt);
    expect(rows[0]?.updatedAt.getTime()).toBe(createdAt);
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.lastError).toContain('no handler');
  });
});

describe('retryEffect', () => {
  async function parkOne(): Promise<number> {
    registerEffectHandler('order', 'order.paid', async () => {
      throw new Error('permanently broken');
    });
    await record();
    await drainEffects(harness.ctx, { maxAttempts: 3, baseBackoffMs: 0, maxBackoffMs: 0 });
    const row = await findEffect(harness.ctx.db, key);
    expect(row?.status).toBe('unknown');
    return row!.id;
  }

  it('un-parks the row and gives it the whole backoff ladder back', async () => {
    const id = await parkOne();
    harness.clock.advance(60_000);

    const { won } = await retryEffect(harness.ctx.db, id, harness.ctx.clock.now());
    expect(won).toBe(true);

    const row = await findEffectById(harness.ctx.db, id);
    expect(row?.status).toBe('pending');
    // Reset, not continued: otherwise the next failure parks it immediately.
    expect(row?.attempts).toBe(0);
    expect(row?.nextRunAt.getTime()).toBe(harness.clock.nowMs());

    // It really is back in the dispatcher's hands.
    resetEffectHandlers();
    registerEffectHandler('order', 'order.paid', async () => {});
    expect((await dispatchEffectsOnce(harness.ctx)).done).toBe(1);
  });

  it('refuses a row that is not parked — pending is the dispatcher’s, done is done', async () => {
    registerEffectHandler('order', 'order.paid', async () => {});
    await record();
    const pending = await findEffect(harness.ctx.db, key);
    expect((await retryEffect(harness.ctx.db, pending!.id, harness.ctx.clock.now())).won).toBe(
      false,
    );

    await dispatchEffectsOnce(harness.ctx);
    expect((await retryEffect(harness.ctx.db, pending!.id, harness.ctx.clock.now())).won).toBe(
      false,
    );
    expect((await findEffect(harness.ctx.db, key))?.status).toBe('done');
  });

  it('refuses a row outside the scopes the caller named', async () => {
    const id = await parkOne();

    const outside = await retryEffect(harness.ctx.db, id, harness.ctx.clock.now(), ['refund']);
    expect(outside.won).toBe(false);
    expect((await findEffectById(harness.ctx.db, id))?.status).toBe('unknown');

    const inside = await retryEffect(harness.ctx.db, id, harness.ctx.clock.now(), ['order']);
    expect(inside.won).toBe(true);
    expect((await findEffectById(harness.ctx.db, id))?.status).toBe('pending');
  });

  it('runs the effect ONCE when two operators press 重试 together', async () => {
    // Two people looking at the same 待处理任务 screen is the normal case, not
    // the exotic one. If the guard were a read-then-write, the handler — which
    // here would be "refund the buyer" — would fire twice.
    const id = await parkOne();

    let runs = 0;
    resetEffectHandlers();
    registerEffectHandler('order', 'order.paid', async () => {
      runs += 1;
    });

    const report = await runConcurrently(
      2,
      () => retryEffect(harness.ctx.db, id, harness.ctx.clock.now()),
      { isWinner: (result) => result.won },
    );
    expect(report.rejected).toEqual([]);
    expect(report.winners).toBe(1);
    expect(report.losers).toBe(1);

    expect((await drainEffects(harness.ctx)).done).toBe(1);
    expect(runs).toBe(1);
    expect((await findEffect(harness.ctx.db, key))?.status).toBe('done');
  });
});

describe('OPS-019 — pruneEffects keeps work and records, drops delivered history', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('deletes only done rows past the window, never parked, pending or shipment rows', async () => {
    registerEffectHandler('order', 'order.paid', async () => {});
    registerEffectHandler('shipment', 'shipment.upload', async () => {});
    registerEffectHandler('refund', 'refund.execute', async () => {
      throw new Error('gateway down');
    });
    await record(); // order: done
    await record({ scope: 'shipment', scopeId: '9', eventType: 'shipment.upload' }); // kept scope
    await record({ scope: 'refund', scopeId: '3', eventType: 'refund.execute' }); // parked
    await drainEffects(harness.ctx, { maxAttempts: 1, baseBackoffMs: 0, maxBackoffMs: 0 });
    await record({ scope: 'order', scopeId: '2', eventType: 'order.paid' }); // still pending

    harness.clock.advance(100 * DAY);
    const removed = await pruneEffects(harness.ctx, { retentionDays: 90, limit: 100 });

    expect(removed).toBe(1);
    expect(await findEffect(harness.ctx.db, key)).toBeNull();
    const left = await harness.ctx.db
      .select({ scope: effectsTable.scope, status: effectsTable.status })
      .from(effectsTable);
    expect(left).toEqual(
      expect.arrayContaining([
        { scope: 'shipment', status: 'done' },
        { scope: 'refund', status: 'unknown' },
        { scope: 'order', status: 'pending' },
      ]),
    );
    expect(left).toHaveLength(3);
  });

  it('keeps a done row inside the window, and deletes at most the limit per run', async () => {
    registerEffectHandler('order', 'order.paid', async () => {});
    for (let i = 1; i <= 3; i += 1) await record({ scopeId: String(i) });
    await drainEffects(harness.ctx);

    harness.clock.advance(30 * DAY);
    expect(await pruneEffects(harness.ctx, { retentionDays: 90, limit: 100 })).toBe(0);

    harness.clock.advance(70 * DAY);
    expect(await pruneEffects(harness.ctx, { retentionDays: 90, limit: 2 })).toBe(2);
    expect(await pruneEffects(harness.ctx, { retentionDays: 90, limit: 2 })).toBe(1);
  });

  it('OPS-020 — counts parked rows in the named scopes only', async () => {
    registerEffectHandler('order', 'order.paid', async () => {
      throw new Error('broken');
    });
    await record();
    await drainEffects(harness.ctx, { maxAttempts: 1, baseBackoffMs: 0, maxBackoffMs: 0 });

    expect(await countParkedEffects(harness.ctx, ['order', 'refund'])).toBe(1);
    expect(await countParkedEffects(harness.ctx, ['refund'])).toBe(0);
    expect(await countParkedEffects(harness.ctx, [])).toBe(0);
  });
});
