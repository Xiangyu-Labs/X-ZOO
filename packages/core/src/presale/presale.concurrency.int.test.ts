import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { products, productSkus } from '@shop/db/schema/catalog';
import { presaleActivities, presaleActivitySkus, presaleOrders } from '@shop/db/schema/presale';
import { orderItems, orders } from '@shop/db/schema/order';
import { users } from '@shop/db/schema/user';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import type { Actor, Ctx } from '../kernel/context';
import { Money } from '../kernel/money';
import { conditionalUpdate, withTx } from '../kernel/tx';
import {
  getStockPort,
  onOrderCancelled,
  onOrderPaid,
  onOrderRefunded,
  resetOrderPorts,
} from '../order/ports';
import { presaleKindHandler } from './presale.order';
import * as repo from './presale.repo';
import { isBalanced } from './presale.rules';
import { registerPresaleDomain } from './index';
// Registers `catalogStockPort` as a side effect of the import. The product
// layers have to move for these assertions to mean anything: a presale sale
// touches four counters and a test that only watched two would pass while the
// warehouse drifted.
import '../catalog/index';

/**
 * The races. STOCK-004, QUEUE-008 and REFUND-002 are from `docs/invariants.md`;
 * the rest are here because every conditional state change in the domain owes
 * one.
 *
 * Two things make these real rather than decorative:
 *
 *  - `runConcurrently` releases every caller from one barrier, so they collide
 *    inside the same statement instead of running in sequence;
 *  - each caller gets its own `Ctx` from `forkTestCtx`, so they hold *different*
 *    pooled connections. Sharing one connection would serialise them and every
 *    assertion below would pass for the wrong reason.
 *
 * Where a caller returns a `conditionalUpdate` result, `isWinner` must read
 * `.won`: the default "truthy" treats `{ affected: 0, won: false }` as a win
 * and the test silently proves nothing.
 *
 * Every checkout here drives the catalog's `StockPort` alongside the presale
 * seams, exactly as the checkout does, because the invariant being proved is
 * about all four counters and not just this domain's two.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  resetOrderPorts();
  registerPresaleDomain();
  // `resetOrderPorts()` clears the stock slot too, and the catalog module's
  // registration already ran at import time.
  const { catalogStockPort } = await import('../catalog/index');
  const { registerStockPort } = await import('../order/ports');
  registerStockPort(catalogStockPort);
});

afterEach(() => {
  resetOrderPorts();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });

/** A caller with its own connection, acting as this user. */
const racer = (userId: number): Ctx => forkTestCtx(harness, { actor: userActor(userId) });

let sequence = 0;

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `ps-race-${sequence}` })
    .returning({ id: users.id });
  return row!.id;
}

interface Fixture {
  activityId: number;
  productId: number;
  skuId: number;
  price: string;
  /** What the four counters read before anything was bought. */
  start: Counters;
}

interface Counters {
  activityStock: number;
  activitySales: number;
  activitySkuStock: number;
  activitySkuSales: number;
  productStock: number;
  productSales: number;
  skuStock: number;
  skuSales: number;
}

async function makeActivity(
  over: { stock?: number; perOrderQuantity?: number; warehouse?: number } = {},
): Promise<Fixture> {
  sequence += 1;
  const stock = over.stock ?? 1;
  const warehouse = over.warehouse ?? 1_000;
  const price = '59.00';

  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `明前龙井${sequence}`,
      imageUrl: 'https://example.test/p.png',
      freightMode: 'free',
      price: '88.00',
      stock: warehouse,
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SKU-${sequence}`,
      specText: '一级|250g',
      specValues: { 等级: '一级' },
      price: '88.00',
      stock: warehouse,
    })
    .returning({ id: productSkus.id });

  const [activity] = await harness.ctx.db
    .insert(presaleActivities)
    .values({
      productId: product!.id,
      title: `春茶预售${sequence}`,
      status: 'active',
      paymentMode: 'full',
      price,
      stock,
      perOrderQuantity: over.perOrderQuantity ?? 2,
      startAt: new Date('2026-05-01T00:00:00.000Z'),
      endAt: new Date('2026-07-01T00:00:00.000Z'),
      shipAfterDays: 15,
    })
    .returning({ id: presaleActivities.id });

  await harness.ctx.db.insert(presaleActivitySkus).values({
    activityId: activity!.id,
    skuId: sku!.id,
    price,
    stock,
    isEnabled: true,
  });

  const fixture = {
    activityId: activity!.id,
    productId: product!.id,
    skuId: sku!.id,
    price,
    start: {} as Counters,
  };
  fixture.start = await readCounters(fixture);
  return fixture;
}

/** All four ledgers, at both levels each. */
async function readCounters(fixture: Fixture): Promise<Counters> {
  const [activity] = await harness.ctx.db
    .select({ stock: presaleActivities.stock, sales: presaleActivities.sales })
    .from(presaleActivities)
    .where(eq(presaleActivities.id, fixture.activityId));
  const [activitySku] = await harness.ctx.db
    .select({ stock: presaleActivitySkus.stock, sales: presaleActivitySkus.sales })
    .from(presaleActivitySkus)
    .where(eq(presaleActivitySkus.activityId, fixture.activityId));
  const [product] = await harness.ctx.db
    .select({ stock: products.stock, sales: products.sales })
    .from(products)
    .where(eq(products.id, fixture.productId));
  const [sku] = await harness.ctx.db
    .select({ stock: productSkus.stock, sales: productSkus.sales })
    .from(productSkus)
    .where(eq(productSkus.id, fixture.skuId));

  return {
    activityStock: activity!.stock,
    activitySales: activity!.sales,
    activitySkuStock: activitySku!.stock,
    activitySkuSales: activitySku!.sales,
    productStock: product!.stock,
    productSales: product!.sales,
    skuStock: sku!.stock,
    skuSales: sku!.sales,
  };
}

async function makeOrderRow(args: {
  userId: number;
  fixture: Fixture;
  quantity: number;
  total: string;
}): Promise<number> {
  sequence += 1;
  const [order] = await harness.ctx.db
    .insert(orders)
    .values({
      orderNo: `PSR${String(sequence).padStart(10, '0')}`,
      userId: args.userId,
      platform: 'h5',
      kind: 'presale',
      status: 'pending_payment',
      totalQuantity: args.quantity,
      itemsAmount: args.total,
      payableAmount: args.total,
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '广东省',
      receiverCity: '深圳市',
      receiverDetail: '某路 1 号',
    })
    .returning({ id: orders.id });
  await harness.ctx.db.insert(orderItems).values({
    orderId: order!.id,
    productId: args.fixture.productId,
    skuId: args.fixture.skuId,
    itemKey: `line-${sequence}`,
    quantity: args.quantity,
    unitPrice: args.fixture.price,
    totalAmount: args.total,
    snapshot: { name: '明前龙井' } as never,
  });
  return order!.id;
}

/**
 * One checkout, as the order domain assembles it: the SKU reservation and the
 * presale seams in the same transaction, so a refusal from either rolls the
 * other back.
 *
 * Throws on refusal, which is what the checkout does; `runConcurrently`
 * collects those as rejections.
 */
async function checkout(args: {
  ctx: Ctx;
  userId: number;
  fixture: Fixture;
  quantity?: number;
}): Promise<number> {
  const quantity = args.quantity ?? 1;
  const total = Money.parse(args.fixture.price).mul(quantity);
  const orderId = await makeOrderRow({
    userId: args.userId,
    fixture: args.fixture,
    quantity,
    total: total.toString(),
  });

  await withTx(args.ctx.db, async (tx) => {
    const meta = await presaleKindHandler.beforeCreate(args.ctx, tx, {
      userId: args.userId,
      lines: [
        {
          skuId: args.fixture.skuId,
          productId: args.fixture.productId,
          quantity,
          unitPrice: Money.parse(args.fixture.price),
          subtotal: total,
        },
      ],
      goodsTotal: total,
      selections: { kind: 'presale', activityId: String(args.fixture.activityId) },
    });
    const failed = await getStockPort().reserve(tx, orderId, [
      { skuId: args.fixture.skuId, quantity },
    ]);
    if (failed.length > 0) throw new Error('catalog stock refused');
    await presaleKindHandler.afterCreate(args.ctx, tx, orderId, meta);
  });

  return orderId;
}

/**
 * The paid transition: the order row, the catalog's stock commit, then the
 * hooks.
 *
 * The order row moves with a *conditional* update carrying the status we
 * believe we are leaving, which is how the order domain does it and the only
 * shape that survives this file. A `SELECT status` followed by an `UPDATE`
 * would let all six callers read `pending_payment` at the same instant and
 * every assertion below would be measuring the driver's bug rather than the
 * domain's guard.
 */
async function pay(ctx: Ctx, orderId: number): Promise<{ won: boolean }> {
  const at = ctx.clock.now();
  return withTx(ctx.db, async (tx) => {
    const [before] = await tx.select().from(orders).where(eq(orders.id, orderId));
    const moved = await conditionalUpdate(tx, orders, {
      where: and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')),
      set: { status: 'paid', paidAt: at, paidAmount: before!.payableAmount },
    });
    if (!moved.won) return { won: false };

    const lines = await repo.orderLines(tx, orderId);
    await getStockPort().commit(tx, orderId, lines);
    await onOrderPaid.dispatch(tx, ctx, {
      orderId,
      orderNo: before!.orderNo,
      userId: before!.userId,
      at,
      paidAmount: Money.parse(before!.payableAmount),
    });
    return { won: true };
  });
}

/** The cancel transition, the same shape. */
async function cancel(ctx: Ctx, orderId: number): Promise<{ won: boolean }> {
  const at = ctx.clock.now();
  return withTx(ctx.db, async (tx) => {
    const [before] = await tx.select().from(orders).where(eq(orders.id, orderId));
    const moved = await conditionalUpdate(tx, orders, {
      where: and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')),
      set: { status: 'cancelled', cancelledAt: at },
    });
    if (!moved.won) return { won: false };

    const lines = await repo.orderLines(tx, orderId);
    await getStockPort().release(tx, orderId, lines);
    await onOrderCancelled.dispatch(tx, ctx, {
      orderId,
      orderNo: before!.orderNo,
      userId: before!.userId,
      at,
      reason: 'timeout',
    });
    return { won: true };
  });
}

async function refund(ctx: Ctx, orderId: number, refundId: number): Promise<void> {
  const at = ctx.clock.now();
  await withTx(ctx.db, async (tx) => {
    const [before] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (before!.paidAt === null) return;
    await tx.update(orders).set({ status: 'refunded' }).where(eq(orders.id, orderId));
    const lines = await repo.orderLines(tx, orderId);
    await getStockPort().release(tx, orderId, lines, { committed: true, refundId });
    await onOrderRefunded.dispatch(tx, ctx, {
      orderId,
      orderNo: before!.orderNo,
      userId: before!.userId,
      at,
      refundId,
      refundedAmount: Money.parse(before!.payableAmount),
      partial: false,
    });
  });
}

const presaleOrderRows = () => harness.ctx.db.select().from(presaleOrders);

// ---------------------------------------------------------------------------
// STOCK-004 — the last unit
// ---------------------------------------------------------------------------

describe('STOCK-004 — the last unit of a campaign, two checkouts at once', () => {
  it('lets exactly one order through', async () => {
    const fixture = await makeActivity({ stock: 1 });
    const buyers = await Promise.all([makeUser(), makeUser()]);

    const report = await runConcurrently(2, (index) => {
      const userId = buyers[index]!;
      return checkout({ ctx: racer(userId), userId, fixture });
    });

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(1);
    // The loser learned it lost the same way a shopper would: 预售库存不足.
    expect(report.rejected[0]).toMatchObject({
      name: 'DomainError',
      code: 'PRESALE_OUT_OF_STOCK',
    });

    expect(await presaleOrderRows()).toHaveLength(1);
    const after = await readCounters(fixture);
    expect(after.activityStock).toBe(0);
    expect(after.activitySkuStock).toBe(0);
    // The loser's SKU reservation rolled back with its transaction: the
    // warehouse is down by exactly the one unit that sold.
    expect(after.skuStock).toBe(fixture.start.skuStock - 1);
    expect(after.productStock).toBe(fixture.start.productStock - 1);
  });

  it('holds under a crowd, not just a pair', async () => {
    const fixture = await makeActivity({ stock: 3 });
    const buyers = await Promise.all(Array.from({ length: 12 }, () => makeUser()));

    const report = await runConcurrently(12, (index) => {
      const userId = buyers[index]!;
      return checkout({ ctx: racer(userId), userId, fixture });
    });

    expect(report.fulfilled).toHaveLength(3);
    expect(report.rejected).toHaveLength(9);
    for (const error of report.rejected) {
      expect(error).toMatchObject({ code: 'PRESALE_OUT_OF_STOCK' });
    }

    const after = await readCounters(fixture);
    expect(after.activityStock).toBe(0);
    expect(after.activitySkuStock).toBe(0);
    expect(after.skuStock).toBe(fixture.start.skuStock - 3);
  });

  it('never oversells the campaign when the warehouse is deep', async () => {
    // The point of a separate counter: 10 000 in stock, 2 on this campaign.
    const fixture = await makeActivity({ stock: 2, warehouse: 10_000 });
    const buyers = await Promise.all(Array.from({ length: 8 }, () => makeUser()));

    const report = await runConcurrently(8, (index) => {
      const userId = buyers[index]!;
      return checkout({ ctx: racer(userId), userId, fixture });
    });

    expect(report.fulfilled).toHaveLength(2);
    expect((await readCounters(fixture)).activityStock).toBe(0);
  });

  it('is the UPDATE that decides, not a prior read — the repo statement alone', async () => {
    const fixture = await makeActivity({ stock: 1 });
    const userId = await makeUser();

    const report = await runConcurrently(
      8,
      () => {
        const ctx = racer(userId);
        return withTx(ctx.db, (tx) =>
          repo.reserveActivityStock(tx, {
            activityId: fixture.activityId,
            skuId: fixture.skuId,
            quantity: 1,
          }),
        );
      },
      // Without this, `false` counts as a win and the assertion below passes
      // even when the guard is broken.
      { isWinner: (won) => won },
    );

    expect(report.winners).toBe(1);
    expect(report.losers).toBe(7);
    expect((await readCounters(fixture)).activityStock).toBe(0);
  });

  it('enforces the campaign quota under the same collision', async () => {
    const fixture = await makeActivity({ stock: 50 });
    await harness.ctx.db
      .update(presaleActivities)
      .set({ totalQuota: 2 })
      .where(eq(presaleActivities.id, fixture.activityId));
    await harness.ctx.db
      .update(presaleActivitySkus)
      .set({ quota: 2, sales: 2 })
      .where(eq(presaleActivitySkus.activityId, fixture.activityId));
    await harness.ctx.db
      .update(presaleActivities)
      .set({ sales: 2 })
      .where(eq(presaleActivities.id, fixture.activityId));

    const buyers = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    const report = await runConcurrently(6, (index) => {
      const userId = buyers[index]!;
      return checkout({ ctx: racer(userId), userId, fixture });
    });

    // Quota exhausted before the race began: stock says yes, the quota says no,
    // and both live in the same WHERE clause.
    expect(report.fulfilled).toHaveLength(0);
    expect((await readCounters(fixture)).activityStock).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// REFUND-002 / QUEUE-008 — cancel racing pay
// ---------------------------------------------------------------------------

describe('REFUND-002 — a cancel racing a payment on a presale order', () => {
  it('lets exactly one win, and the four ledgers agree with whichever it was', async () => {
    const fixture = await makeActivity({ stock: 5 });
    const userId = await makeUser();
    const orderId = await checkout({ ctx: racer(userId), userId, fixture, quantity: 2 });

    const held = await readCounters(fixture);
    expect(held.activityStock).toBe(3);
    expect(held.skuStock).toBe(fixture.start.skuStock - 2);

    const report = await runConcurrently(
      2,
      (index) => {
        const ctx = racer(userId);
        return index === 0 ? pay(ctx, orderId) : cancel(ctx, orderId);
      },
      { isWinner: (result) => result.won },
    );

    // The order aggregate decides; this domain follows whichever way it fell.
    expect(report.winners).toBe(1);
    expect(report.rejected).toHaveLength(0);

    const [order] = await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    const presale = (await presaleOrderRows())[0]!;
    const after = await readCounters(fixture);
    const ledger = await repo.listStockLedger(harness.ctx.db, orderId);

    if (order!.status === 'paid') {
      expect(presale.stage).toBe('final_paid');
      // Sold: stock stays down, `sales` up, on both the campaign and the SKU.
      expect(after).toMatchObject({
        activityStock: 3,
        activitySales: 2,
        activitySkuStock: 3,
        activitySkuSales: 2,
        skuStock: fixture.start.skuStock - 2,
        skuSales: fixture.start.skuSales + 2,
        productStock: fixture.start.productStock - 2,
        productSales: fixture.start.productSales + 2,
      });
      expect(ledger).toHaveLength(1);
    } else {
      expect(order!.status).toBe('cancelled');
      expect(presale.stage).toBe('cancelled');
      // Not sold: everything back exactly where it started, all four ledgers.
      expect(after).toEqual(fixture.start);
      expect(ledger.map((row) => row.reason)).toEqual(['reserve', 'release']);
      expect(isBalanced(ledger)).toBe(true);
    }
  });

  it('balances all four ledgers when the cancellation wins, ten times running', async () => {
    // The interesting half of the race, forced: the order is cancelled by the
    // time the payment tries, so the release path is the one under test.
    for (let round = 0; round < 10; round += 1) {
      await harness.db.truncateAll();
      const fixture = await makeActivity({ stock: 5 });
      const userId = await makeUser();
      const orderId = await checkout({ ctx: racer(userId), userId, fixture, quantity: 2 });

      const report = await runConcurrently(4, () => cancel(racer(userId), orderId), {
        isWinner: (result) => result.won,
      });
      expect(report.winners).toBe(1);

      expect(await readCounters(fixture)).toEqual(fixture.start);
      const ledger = await repo.listStockLedger(harness.ctx.db, orderId);
      expect(ledger).toHaveLength(2);
      expect(isBalanced(ledger)).toBe(true);
    }
  });

  it('balances all four ledgers when a refund races itself', async () => {
    const fixture = await makeActivity({ stock: 5 });
    const userId = await makeUser();
    const orderId = await checkout({ ctx: racer(userId), userId, fixture, quantity: 2 });
    await pay(racer(userId), orderId);

    // One refund, six deliveries of it. `UNIQUE (order_id, reason)` is what
    // makes the extra five free.
    const report = await runConcurrently(6, () => refund(racer(userId), orderId, 77));
    expect(report.rejected).toHaveLength(0);

    expect(await readCounters(fixture)).toEqual(fixture.start);
    const ledger = await repo.listStockLedger(harness.ctx.db, orderId);
    expect(ledger).toHaveLength(2);
    expect(isBalanced(ledger)).toBe(true);
    expect((await presaleOrderRows())[0]!.stage).toBe('cancelled');
  });

  it('commits the sale once when the payment callback arrives many times at once', async () => {
    // QUEUE-008: WeChat retries, and `sales` must not drift.
    const fixture = await makeActivity({ stock: 5 });
    const userId = await makeUser();
    const orderId = await checkout({ ctx: racer(userId), userId, fixture, quantity: 2 });

    const report = await runConcurrently(6, () => pay(racer(userId), orderId), {
      isWinner: (result) => result.won,
    });
    expect(report.winners).toBe(1);

    const after = await readCounters(fixture);
    expect(after.activitySales).toBe(2);
    expect(after.activitySkuSales).toBe(2);
    expect(after.skuSales).toBe(fixture.start.skuSales + 2);
    expect(await repo.listStockLedger(harness.ctx.db, orderId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// the remaining conditional state changes
// ---------------------------------------------------------------------------

describe('the other conditional updates', () => {
  it('lets one operator win a status change, not both', async () => {
    const fixture = await makeActivity({ stock: 5 });
    const report = await runConcurrently(
      6,
      () => {
        const ctx = racer(1);
        return withTx(ctx.db, (tx) =>
          repo.setActivityStatus(tx, {
            id: fixture.activityId,
            from: ['active'],
            to: 'paused',
            now: ctx.clock.now(),
          }),
        );
      },
      { isWinner: (result) => result.won },
    );

    // Five of the six find the campaign is no longer `active`; the `from` list
    // is what tells them so, and none of them can move it a second time.
    expect(report.winners).toBe(1);
    const [row] = await harness.ctx.db
      .select()
      .from(presaleActivities)
      .where(eq(presaleActivities.id, fixture.activityId));
    expect(row?.status).toBe('paused');
  });

  it('closes an expired campaign once, however many sweeps collide', async () => {
    const fixture = await makeActivity({ stock: 5 });
    await harness.ctx.db
      .update(presaleActivities)
      .set({ endAt: new Date('2026-05-20T00:00:00.000Z') })
      .where(eq(presaleActivities.id, fixture.activityId));

    const report = await runConcurrently(
      5,
      () => {
        const ctx = racer(1);
        return withTx(ctx.db, (tx) =>
          repo.closeActivity(tx, { id: fixture.activityId, now: ctx.clock.now() }),
        );
      },
      { isWinner: (result) => result.won },
    );

    expect(report.winners).toBe(1);
    const [row] = await harness.ctx.db
      .select()
      .from(presaleActivities)
      .where(eq(presaleActivities.id, fixture.activityId));
    expect(row?.status).toBe('ended');
  });

  it('claims each direction of the ledger exactly once', async () => {
    const fixture = await makeActivity({ stock: 5 });
    const userId = await makeUser();
    const orderId = await checkout({ ctx: racer(userId), userId, fixture });

    // Six callers racing for the one release row this order may ever have.
    const report = await runConcurrently(
      6,
      () => {
        const ctx = racer(userId);
        return withTx(ctx.db, (tx) =>
          repo.claimStockLedger(tx, 'release', {
            activityId: fixture.activityId,
            activitySkuId: null,
            skuId: fixture.skuId,
            orderId,
            quantity: 1,
            activityStockDelta: 1,
            activitySalesDelta: 0,
            productStockDelta: 1,
            productSalesDelta: 0,
          }),
        );
      },
      { isWinner: (row) => row !== null },
    );

    expect(report.winners).toBe(1);
    expect(report.rejected).toHaveLength(0);
    expect(await repo.listStockLedger(harness.ctx.db, orderId)).toHaveLength(2);
  });
});
