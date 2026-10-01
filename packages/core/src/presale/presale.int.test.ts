import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { products, productSkus } from '@shop/db/schema/catalog';
import { notificationMessages } from '@shop/db/schema/notification';
import { effects } from '@shop/db/schema/system';
import { wechatIdentities } from '@shop/db/schema/wechat';
import { presaleActivities, presaleActivitySkus, presaleOrders } from '@shop/db/schema/presale';
import { orderItems, orders } from '@shop/db/schema/order';
import { refunds } from '@shop/db/schema/refund';
import { users } from '@shop/db/schema/user';
import type { Tx } from '@shop/db';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import { getEffectHandler } from '../effects/index';
import { notificationAdmin, registerSmsPort, type SmsPort } from '../notification';
import { resetWechatTokenFlight, wechatConfig } from '../wechat';
import type { Actor, Ctx } from '../kernel/context';
import { Money } from '../kernel/money';
import { withTx } from '../kernel/tx';
import { splitAdjustments } from '../order';
import {
  getPricingContributors,
  onOrderCancelled,
  onOrderPaid,
  onOrderRefunded,
  registerPricingContributor,
  resetOrderPorts,
  type PriceAdjustment,
  type PricingDraft,
} from '../order/ports';
import { presaleConfig } from './presale.config';
import { sweepPresaleWindows } from './presale.jobs';
import { presaleKindHandler } from './presale.order';
import * as repo from './presale.repo';
import { isBalanced } from './presale.rules';
import * as service from './presale.service';
import { clearAutoRefundPort, registerAutoRefundPort, registerPresaleDomain } from './index';

/**
 * The presale domain against a real PostgreSQL 17.
 *
 * The races live next door in `presale.concurrency.int.test.ts`; this file
 * proves the *shapes*: what an order refuses before a row exists, what a
 * payment does to the campaign's own counters, what a cancel and a refund put
 * back, and that the window sweep opens and closes on time.
 *
 * Orders are written directly rather than through the real checkout. This
 * domain attaches to the order aggregate through `order/ports.ts`, and driving
 * the whole checkout here would be testing the order domain. What the two
 * halves of the kind handler do inside one transaction is exactly what the
 * checkout does with them.
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
  // `truncateAll` empties the settings table but not the config cache, and a
  // test that narrows the sweep's lookback would otherwise leak it into the next.
  await harness.ctx.config.invalidate(presaleConfig.group);
  harness.clock.set(NOW);
  resetOrderPorts();
  clearAutoRefundPort();
  registerPresaleDomain();
});

afterEach(() => {
  resetOrderPorts();
  clearAutoRefundPort();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const asUser = (id: number): Ctx => harness.as(userActor(id));
const asAdmin = (permissions: string[]): Ctx =>
  harness.as({ kind: 'admin', id: 1, permissions, isSuper: false });

let sequence = 0;

async function makeUser(nickname?: string): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({
      account: `ps-u-${sequence}`,
      nickname: nickname ?? `顾客${sequence}`,
      avatarUrl: `https://example.test/u/${sequence}.png`,
    })
    .returning({ id: users.id });
  return row!.id;
}

interface ActivityFixture {
  activityId: number;
  productId: number;
  skuId: number;
  price: string;
  shipAfterDays: number;
}

async function makeActivity(
  over: {
    stock?: number;
    totalQuota?: number | null;
    skuQuota?: number | null;
    perOrderQuantity?: number;
    price?: string;
    status?: 'draft' | 'active' | 'paused' | 'ended';
    paymentMode?: 'full' | 'deposit';
    shipAfterDays?: number;
    startAt?: Date;
    endAt?: Date;
    skuEnabled?: boolean;
  } = {},
): Promise<ActivityFixture> {
  sequence += 1;
  const stock = over.stock ?? 100;
  const price = over.price ?? '59.00';
  const shipAfterDays = over.shipAfterDays ?? 15;
  const deposit = over.paymentMode === 'deposit';

  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `明前龙井${sequence}`,
      imageUrl: 'https://example.test/p.png',
      // `products_freight_source` insists a `template` product names a template.
      freightMode: 'free',
      price: '88.00',
      stock: 1_000,
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
      originalPrice: '108.00',
      stock: 1_000,
    })
    .returning({ id: productSkus.id });

  const [activity] = await harness.ctx.db
    .insert(presaleActivities)
    .values({
      productId: product!.id,
      title: `春茶预售${sequence}`,
      imageUrl: 'https://example.test/p.png',
      status: over.status ?? 'active',
      paymentMode: deposit ? 'deposit' : 'full',
      price,
      originalPrice: '88.00',
      // `presale_activities_deposit_shape` insists the four move together.
      ...(deposit
        ? {
            depositAmount: '10.00',
            finalPaymentStartAt: new Date('2026-06-10T00:00:00.000Z'),
            finalPaymentEndAt: new Date('2026-06-20T00:00:00.000Z'),
          }
        : {}),
      stock,
      totalQuota: over.totalQuota === undefined ? null : over.totalQuota,
      perOrderQuantity: over.perOrderQuantity ?? 2,
      startAt: over.startAt ?? new Date('2026-05-01T00:00:00.000Z'),
      endAt: over.endAt ?? new Date('2026-07-01T00:00:00.000Z'),
      shipAfterDays,
    })
    .returning({ id: presaleActivities.id });

  await harness.ctx.db.insert(presaleActivitySkus).values({
    activityId: activity!.id,
    skuId: sku!.id,
    price,
    stock,
    quota: over.skuQuota === undefined ? null : over.skuQuota,
    isEnabled: over.skuEnabled ?? true,
  });

  return {
    activityId: activity!.id,
    productId: product!.id,
    skuId: sku!.id,
    price,
    shipAfterDays,
  };
}

async function makeOrder(args: {
  userId: number;
  fixture: ActivityFixture;
  quantity?: number;
  amount?: string;
}): Promise<{ orderId: number; orderNo: string }> {
  sequence += 1;
  const quantity = args.quantity ?? 1;
  const amount = args.amount ?? args.fixture.price;
  const orderNo = `PS${String(sequence).padStart(10, '0')}`;
  const [order] = await harness.ctx.db
    .insert(orders)
    .values({
      orderNo,
      userId: args.userId,
      platform: 'h5',
      kind: 'presale',
      status: 'pending_payment',
      totalQuantity: quantity,
      itemsAmount: amount,
      payableAmount: amount,
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
    quantity,
    unitPrice: amount,
    totalAmount: amount,
    snapshot: { name: '明前龙井' } as never,
  });
  return { orderId: order!.id, orderNo };
}

/**
 * The whole "place a presale order" path as the checkout drives it: the kind
 * handler's two halves inside one transaction.
 *
 * `lines` is a single line on purpose — `assertOrderShape` refuses anything
 * else, and `presale_stock_ledger_order_reason_uq` is why.
 */
async function placeOrder(args: {
  userId: number;
  fixture: ActivityFixture;
  quantity?: number;
  amount?: string;
  skuId?: number;
}): Promise<number> {
  const order = await makeOrder(args);
  const ctx = asUser(args.userId);
  const quantity = args.quantity ?? 1;
  const total = Money.parse(args.amount ?? args.fixture.price).mul(quantity);
  const lines = [
    {
      skuId: args.skuId ?? args.fixture.skuId,
      productId: args.fixture.productId,
      quantity,
      unitPrice: Money.parse(args.amount ?? args.fixture.price),
      subtotal: total,
    },
  ];
  await withTx(harness.ctx.db, async (tx) => {
    const draft: PricingDraft = {
      userId: args.userId,
      lines,
      goodsTotal: total,
      selections: { kind: 'presale', activityId: String(args.fixture.activityId) },
    };
    const meta = await presaleKindHandler.beforeCreate(ctx, tx, {
      ...draft,
      adjustments: await priceDraft(ctx, tx, draft),
    });
    await presaleKindHandler.afterCreate(ctx, tx, order.orderId, meta);
  });
  return order.orderId;
}

/**
 * The checkout's pricing pass, in miniature.
 *
 * `beforeCreate` does not re-run the contributor to find out whether it fired:
 * `create` hands it what the pass actually applied. A driver that did not do
 * the same would be testing a guard against a draft no real checkout produces,
 * so this runs every registered contributor over the draft and splits the
 * result exactly as `create` does — on the caller's transaction, which is also
 * how the checkout avoids a second pooled connection.
 */
async function priceDraft(ctx: Ctx, tx: Tx, draft: PricingDraft) {
  const reading = { ...ctx, db: tx as Ctx['db'] };
  const raw: PriceAdjustment[] = [];
  for (const contributor of getPricingContributors()) {
    raw.push(...(await contributor.contribute(reading, draft)));
  }
  return splitAdjustments(draft.lines, raw).applied;
}

/** Marks the order paid and fires the hook, the way the payment callback does. */
async function pay(orderId: number): Promise<void> {
  const at = harness.clock.now();
  await withTx(harness.ctx.db, async (tx) => {
    const [before] = await tx.select().from(orders).where(eq(orders.id, orderId));
    await tx
      .update(orders)
      .set({ status: 'paid', paidAt: at, paidAmount: before!.payableAmount })
      .where(eq(orders.id, orderId));
    await onOrderPaid.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: before!.orderNo,
      userId: before!.userId,
      at,
      paidAmount: Money.parse(before!.payableAmount),
    });
  });
}

/**
 * Cancels the order and fires the hook.
 *
 * `moveOrder: false` fires the hook alone. That is not an artificial case: it
 * is the cancel that *lost* the race to a payment, and the order aggregate
 * itself will not let the row move — `orders_paid_shape` forbids a cancelled
 * order that has a `paid_at`. What this domain has to prove is that the losing
 * hook changes nothing.
 */
async function cancel(orderId: number, moveOrder = true): Promise<void> {
  const at = harness.clock.now();
  await withTx(harness.ctx.db, async (tx) => {
    if (moveOrder) {
      // `orders_cancelled_shape` insists the two move together.
      await tx
        .update(orders)
        .set({ status: 'cancelled', cancelledAt: at })
        .where(eq(orders.id, orderId));
    }
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    await onOrderCancelled.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: order!.orderNo,
      userId: order!.userId,
      at,
      reason: 'timeout',
    });
  });
}

/**
 * Refunds the order and fires the hook.
 *
 * The row only moves when there is money to give back: `orders_paid_shape`
 * insists a `refunded` order has a `paid_at`, so a refund callback for an
 * unpaid order is a hook firing over a row that stays where it is.
 */
async function refund(orderId: number, partial = false): Promise<void> {
  const at = harness.clock.now();
  await withTx(harness.ctx.db, async (tx) => {
    const [before] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!partial && before!.paidAt !== null) {
      await tx.update(orders).set({ status: 'refunded' }).where(eq(orders.id, orderId));
    }
    await onOrderRefunded.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: before!.orderNo,
      userId: before!.userId,
      at,
      refundId: 1,
      refundedAmount: Money.parse(before!.payableAmount),
      partial,
    });
  });
}

async function readCounters(fixture: ActivityFixture) {
  const [activity] = await harness.ctx.db
    .select({ stock: presaleActivities.stock, sales: presaleActivities.sales })
    .from(presaleActivities)
    .where(eq(presaleActivities.id, fixture.activityId));
  const [sku] = await harness.ctx.db
    .select({ stock: presaleActivitySkus.stock, sales: presaleActivitySkus.sales })
    .from(presaleActivitySkus)
    .where(eq(presaleActivitySkus.activityId, fixture.activityId));
  return { activity: activity!, sku: sku! };
}

const readPresaleOrder = (orderId: number) =>
  harness.ctx.db
    .select()
    .from(presaleOrders)
    .where(eq(presaleOrders.orderId, orderId))
    .then((rows) => rows[0]);

async function effectsFor(scopeId: string, eventType: string) {
  const rows = await harness.ctx.db.select().from(effects).where(eq(effects.scopeId, scopeId));
  return rows.filter((row) => row.eventType === eventType);
}

// ---------------------------------------------------------------------------

describe('beforeCreate', () => {
  it('accepts an order the campaign repriced, at the catalogue price', async () => {
    const fixture = await makeActivity();
    const userId = await makeUser();
    // 88.00 is the catalogue price, which is what the *lines* carry: a
    // contributor never rewrites a line, it contributes an adjustment that
    // lands in `orders.coupon_discount`. The guard compares the discount the
    // campaign owes against what the contributor produces, so this — the
    // ordinary, correctly priced presale order — passes.
    await expect(placeOrder({ userId, fixture, amount: '88.00' })).resolves.toBeGreaterThan(0);
    expect(await readCounters(fixture)).toMatchObject({ activity: { stock: 99, sales: 0 } });
  });

  it('refuses an order the pricing contributor did not reprice', async () => {
    const fixture = await makeActivity();
    const userId = await makeUser();
    // The registry replaces by name, so a no-op under the presale contributor's
    // own name is exactly "the contributor stopped firing" — the one failure
    // that would bill a shopper 88.00 for a 59.00 presale.
    registerPricingContributor({
      name: 'presale:activity-price',
      priority: 50,
      contribute: async () => [],
    });
    await expect(placeOrder({ userId, fixture, amount: '88.00' })).rejects.toMatchObject({
      code: 'PRESALE_PRICE_NOT_APPLIED',
    });
    // Nothing was taken: the refusal happens before any counter moves.
    expect(await readCounters(fixture)).toMatchObject({ activity: { stock: 100, sales: 0 } });
  });

  it('refuses a campaign that is paused, not started, or already over', async () => {
    const userId = await makeUser();

    const paused = await makeActivity({ status: 'paused' });
    await expect(placeOrder({ userId, fixture: paused })).rejects.toMatchObject({
      code: 'PRESALE_ACTIVITY_NOT_OPEN',
    });

    const future = await makeActivity({
      startAt: new Date('2026-06-10T00:00:00.000Z'),
      endAt: new Date('2026-06-20T00:00:00.000Z'),
    });
    await expect(placeOrder({ userId, fixture: future })).rejects.toMatchObject({
      code: 'PRESALE_ACTIVITY_NOT_OPEN',
    });

    const past = await makeActivity({
      startAt: new Date('2026-04-01T00:00:00.000Z'),
      endAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    await expect(placeOrder({ userId, fixture: past })).rejects.toMatchObject({
      code: 'PRESALE_ACTIVITY_NOT_OPEN',
    });
  });

  it('refuses a deposit campaign outright rather than half-selling it', async () => {
    const fixture = await makeActivity({ paymentMode: 'deposit' });
    const userId = await makeUser();
    await expect(placeOrder({ userId, fixture })).rejects.toMatchObject({
      code: 'PRESALE_DEPOSIT_NOT_SUPPORTED',
    });
  });

  it('refuses an over-large quantity and a SKU outside the campaign', async () => {
    const userId = await makeUser();

    const capped = await makeActivity({ perOrderQuantity: 1 });
    await expect(placeOrder({ userId, fixture: capped, quantity: 2 })).rejects.toMatchObject({
      code: 'PRESALE_QUANTITY_NOT_ALLOWED',
    });

    const other = await makeActivity();
    await expect(placeOrder({ userId, fixture: capped, skuId: other.skuId })).rejects.toMatchObject(
      { code: 'PRESALE_SKU_NOT_IN_ACTIVITY' },
    );
  });

  it('refuses an unknown campaign', async () => {
    const fixture = await makeActivity();
    const userId = await makeUser();
    await expect(
      placeOrder({ userId, fixture: { ...fixture, activityId: 999_999 } }),
    ).rejects.toMatchObject({ code: 'PRESALE_ACTIVITY_NOT_FOUND' });
  });
});

describe('placing an order', () => {
  it('holds the campaign stock, records the reservation and starts on final_pending', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser('小明');
    const orderId = await placeOrder({ userId, fixture, quantity: 2, amount: '59.00' });

    const counters = await readCounters(fixture);
    // A placed order holds stock but has sold nothing: `sales` waits for money.
    expect(counters.activity).toEqual({ stock: 8, sales: 0 });
    expect(counters.sku).toEqual({ stock: 8, sales: 0 });

    const presale = await readPresaleOrder(orderId);
    expect(presale).toMatchObject({
      activityId: fixture.activityId,
      paymentMode: 'full',
      stage: 'final_pending',
      depositAmount: null,
      finalAmount: '118.00',
      // The order domain owns the payment deadline; a second countdown would be
      // a second answer to the same question.
      finalDueAt: null,
      finalPaidAt: null,
      shipNotBeforeAt: null,
    });

    const ledger = await repo.listStockLedger(harness.ctx.db, orderId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      reason: 'reserve',
      quantity: 2,
      activityStockDelta: -2,
      activitySalesDelta: 0,
      productStockDelta: -2,
      productSalesDelta: 0,
    });
  });

  it('refuses when the campaign is out of its own stock, even though the SKU is not', async () => {
    // STOCK-004: the campaign's 500 units are not the warehouse's 10 000.
    const fixture = await makeActivity({ stock: 1 });
    const first = await makeUser();
    const second = await makeUser();
    await placeOrder({ userId: first, fixture });
    await expect(placeOrder({ userId: second, fixture })).rejects.toMatchObject({
      code: 'PRESALE_OUT_OF_STOCK',
    });
    expect((await readCounters(fixture)).activity).toEqual({ stock: 0, sales: 0 });
  });

  it('enforces the campaign quota in the same statement as the stock', async () => {
    // Not a separate SELECT on `total_quota` and then a decrement: that
    // oversells.
    const fixture = await makeActivity({ stock: 10, totalQuota: 1 });
    const first = await makeUser();
    const second = await makeUser();
    const orderId = await placeOrder({ userId: first, fixture });
    await pay(orderId);
    await expect(placeOrder({ userId: second, fixture })).rejects.toMatchObject({
      code: 'PRESALE_OUT_OF_STOCK',
    });
  });

  it('treats a disabled SKU as not being in the campaign at all', async () => {
    const fixture = await makeActivity({ stock: 10, skuEnabled: false });
    const userId = await makeUser();
    // Not 库存不足 — the shopper is told the spec is not on sale, which is what
    // an operator who unticked 可售 meant, and it is refused before any counter
    // is touched.
    await expect(placeOrder({ userId, fixture })).rejects.toMatchObject({
      code: 'PRESALE_SKU_NOT_IN_ACTIVITY',
    });
    expect((await readCounters(fixture)).activity).toEqual({ stock: 10, sales: 0 });
  });

  it('reserves once however often the creation is replayed (QUEUE-008)', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture });

    // A retried `afterCreate` for the same order: the ledger claim returns null
    // and nothing at all happens a second time.
    const ctx = asUser(userId);
    await withTx(harness.ctx.db, (tx) =>
      presaleKindHandler.afterCreate(ctx, tx, orderId, {
        activityId: fixture.activityId,
        userId,
        skuId: fixture.skuId,
        quantity: 1,
        goodsTotal: fixture.price,
        shipAfterDays: fixture.shipAfterDays,
      }),
    );

    expect((await readCounters(fixture)).activity).toEqual({ stock: 9, sales: 0 });
    expect(await repo.listStockLedger(harness.ctx.db, orderId)).toHaveLength(1);
  });
});

describe('paying', () => {
  it('turns the reservation into a sale and freezes the 发货承诺', async () => {
    const fixture = await makeActivity({ stock: 10, shipAfterDays: 15 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture });
    await pay(orderId);

    const counters = await readCounters(fixture);
    // Stock stays down — it left the shelf when the order was placed.
    expect(counters.activity).toEqual({ stock: 9, sales: 1 });
    expect(counters.sku).toEqual({ stock: 9, sales: 1 });

    const presale = await readPresaleOrder(orderId);
    expect(presale?.stage).toBe('final_paid');
    expect(presale?.finalPaidAt?.toISOString()).toBe(NOW);
    expect(presale?.shipNotBeforeAt?.toISOString()).toBe('2026-06-16T00:00:00.000Z');

    expect(await effectsFor(String(orderId), 'presale.paid')).toHaveLength(1);
  });

  it('records the sale on the reservation row, so the ledger can still balance', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture, quantity: 2, amount: '59.00' });
    await pay(orderId);

    const [reservation] = await repo.listStockLedger(harness.ctx.db, orderId);
    // The sale has no row of its own — the reason enum has two values — so the
    // reservation row is amended to say what it now means.
    expect(reservation).toMatchObject({
      reason: 'reserve',
      activityStockDelta: -2,
      activitySalesDelta: 2,
      productStockDelta: -2,
      productSalesDelta: 2,
    });
  });

  it('commits the sale once however often the callback is replayed', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture });
    await pay(orderId);
    await pay(orderId);
    await pay(orderId);

    // The stage guard, not the effect ledger, is what makes this safe: a second
    // callback finds `stage = 'final_paid'` and `from: ['final_pending']` matches
    // nothing.
    expect((await readCounters(fixture)).activity).toEqual({ stock: 9, sales: 1 });
    expect(await effectsFor(String(orderId), 'presale.paid')).toHaveLength(1);
  });

  it('keeps the promise a later edit of the campaign tries to move', async () => {
    const fixture = await makeActivity({ stock: 10, shipAfterDays: 15 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture });
    await pay(orderId);

    await harness.ctx.db
      .update(presaleActivities)
      .set({ shipAfterDays: 30 })
      .where(eq(presaleActivities.id, fixture.activityId));

    // 15 days from payment, not 30: the operator shortened nobody's promise.
    const presale = await readPresaleOrder(orderId);
    expect(presale?.shipNotBeforeAt?.toISOString()).toBe('2026-06-16T00:00:00.000Z');
  });

  it('ignores an order that is not a presale', async () => {
    const fixture = await makeActivity();
    const userId = await makeUser();
    const { orderId } = await makeOrder({ userId, fixture });
    await expect(pay(orderId)).resolves.toBeUndefined();
    expect(await readPresaleOrder(orderId)).toBeUndefined();
  });

  /**
   * STOCK-004: 限购总量 is a ceiling on units **sold**, and `sales` only moves
   * when the money arrives — so the quota has to be enforced *here*, not only
   * at checkout. Two shoppers can both hold a reservation against a quota of
   * one; only one of them can be sold to.
   */
  describe('限购总量 refuses a payment', () => {
    it('gives the units back and asks for the money back', async () => {
      const fixture = await makeActivity({ stock: 10, totalQuota: 1 });
      const first = await placeOrder({ userId: await makeUser('先付的'), fixture });
      const second = await placeOrder({ userId: await makeUser('后付的'), fixture });

      await pay(first);
      await pay(second);

      // One sale, and the loser's two units are back on the shelf.
      expect((await readCounters(fixture)).activity).toEqual({ stock: 9, sales: 1 });
      expect((await readCounters(fixture)).sku).toEqual({ stock: 9, sales: 1 });

      expect((await readPresaleOrder(first))?.stage).toBe('final_paid');
      expect((await readPresaleOrder(second))?.stage).toBe('cancelled');

      // The money is already the shop's, so it has to be given back — and it is
      // asked for as an effect, so the gateway call happens after commit.
      expect(await effectsFor(String(second), 'presale.refund')).toHaveLength(1);
      expect(await effectsFor(String(second), 'presale.paid')).toHaveLength(0);
      expect(await effectsFor(String(first), 'presale.refund')).toHaveLength(0);

      // REFUND-002 on the loser: reservation and release cancel out exactly,
      // and `sales` never moved on either row.
      const ledger = await repo.listStockLedger(harness.ctx.db, second);
      expect(ledger).toHaveLength(2);
      expect(isBalanced(ledger)).toBe(true);
      expect(ledger.map((row) => row.activitySalesDelta)).toEqual([0, 0]);
    });

    it('enforces the per-SKU quota the same way', async () => {
      const fixture = await makeActivity({ stock: 10, skuQuota: 1 });
      const first = await placeOrder({ userId: await makeUser(), fixture });
      const second = await placeOrder({ userId: await makeUser(), fixture });

      await pay(first);
      await pay(second);

      expect((await readCounters(fixture)).sku).toEqual({ stock: 9, sales: 1 });
      expect(await effectsFor(String(second), 'presale.refund')).toHaveLength(1);
    });

    it('does not half-apply the sale when only the campaign quota refuses', async () => {
      // The SKU has room, the campaign does not — the case that needs the undo.
      const fixture = await makeActivity({ stock: 10, totalQuota: 1, skuQuota: 5 });
      const first = await placeOrder({ userId: await makeUser(), fixture });
      const second = await placeOrder({ userId: await makeUser(), fixture });

      await pay(first);
      await pay(second);

      const counters = await readCounters(fixture);
      expect(counters.activity.sales).toBe(1);
      // Without the compensating update this would read 2: the SKU half landed
      // before the campaign half refused.
      expect(counters.sku.sales).toBe(1);
    });

    it('asks for the refund once however often the callback is replayed', async () => {
      const fixture = await makeActivity({ stock: 10, totalQuota: 1 });
      const first = await placeOrder({ userId: await makeUser(), fixture });
      const second = await placeOrder({ userId: await makeUser(), fixture });

      await pay(first);
      await pay(second);
      await pay(second);
      await pay(second);

      expect(await effectsFor(String(second), 'presale.refund')).toHaveLength(1);
      expect((await readCounters(fixture)).activity).toEqual({ stock: 9, sales: 1 });
      expect(isBalanced(await repo.listStockLedger(harness.ctx.db, second))).toBe(true);
    });
  });
});

describe('cancelling', () => {
  it('gives the reservation back and leaves sales alone', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture, quantity: 2, amount: '59.00' });
    await cancel(orderId);

    const counters = await readCounters(fixture);
    expect(counters.activity).toEqual({ stock: 10, sales: 0 });
    expect(counters.sku).toEqual({ stock: 10, sales: 0 });
    expect((await readPresaleOrder(orderId))?.stage).toBe('cancelled');

    // REFUND-002: the two ledger rows cancel out on all four columns.
    const ledger = await repo.listStockLedger(harness.ctx.db, orderId);
    expect(ledger.map((row) => row.reason)).toEqual(['reserve', 'release']);
    expect(isBalanced(ledger)).toBe(true);
    expect(await effectsFor(String(orderId), 'presale.released')).toHaveLength(1);
  });

  it('releases once however often the cancellation is replayed', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture });
    await cancel(orderId);
    await cancel(orderId);

    expect((await readCounters(fixture)).activity).toEqual({ stock: 10, sales: 0 });
    expect(await repo.listStockLedger(harness.ctx.db, orderId)).toHaveLength(2);
  });

  it('does nothing when the cancellation lost the race to a payment', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture });
    await pay(orderId);
    await cancel(orderId, false);

    // A paid presale is refunded, not cancelled: the stage guard finds nothing
    // in `final_pending`, the hook returns, and the sale stands.
    expect((await readCounters(fixture)).activity).toEqual({ stock: 9, sales: 1 });
    expect((await readPresaleOrder(orderId))?.stage).toBe('final_paid');
    expect(await repo.listStockLedger(harness.ctx.db, orderId)).toHaveLength(1);
  });
});

describe('refunding', () => {
  it('walks stock and sales back together', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture, quantity: 2, amount: '59.00' });
    await pay(orderId);
    expect((await readCounters(fixture)).activity).toEqual({ stock: 8, sales: 2 });

    await refund(orderId);

    // REFUND-003: back exactly where the campaign started.
    expect((await readCounters(fixture)).activity).toEqual({ stock: 10, sales: 0 });
    expect((await readCounters(fixture)).sku).toEqual({ stock: 10, sales: 0 });
    expect((await readPresaleOrder(orderId))?.stage).toBe('cancelled');

    const ledger = await repo.listStockLedger(harness.ctx.db, orderId);
    expect(ledger[1]).toMatchObject({
      reason: 'release',
      activityStockDelta: 2,
      activitySalesDelta: -2,
      productStockDelta: 2,
      productSalesDelta: -2,
    });
    expect(isBalanced(ledger)).toBe(true);
  });

  it('leaves everything alone on a partial refund', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture, quantity: 2, amount: '59.00' });
    await pay(orderId);
    await refund(orderId, true);

    // The shopper still holds the presale; they got money back for part of it.
    expect((await readCounters(fixture)).activity).toEqual({ stock: 8, sales: 2 });
    expect((await readPresaleOrder(orderId))?.stage).toBe('final_paid');
    expect(await repo.listStockLedger(harness.ctx.db, orderId)).toHaveLength(1);
  });

  it('restores once however often the refund callback arrives', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture });
    await pay(orderId);
    await refund(orderId);
    await refund(orderId);
    await refund(orderId);

    expect((await readCounters(fixture)).activity).toEqual({ stock: 10, sales: 0 });
    expect(await repo.listStockLedger(harness.ctx.db, orderId)).toHaveLength(2);
  });

  it('refunds an unpaid order without taking sales below zero', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture });
    // Never paid, so `sales` was never raised; the release must not lower it.
    await refund(orderId);

    expect((await readCounters(fixture)).activity).toEqual({ stock: 10, sales: 0 });
    expect(isBalanced(await repo.listStockLedger(harness.ctx.db, orderId))).toBe(true);
  });
});

describe('the window sweep', () => {
  it('closes a campaign whose window has passed and records it once', async () => {
    const fixture = await makeActivity({
      startAt: new Date('2026-05-01T00:00:00.000Z'),
      endAt: new Date('2026-05-20T00:00:00.000Z'),
    });

    const first = await sweepPresaleWindows(harness.ctx);
    expect(first).toMatchObject({ scanned: 1, closed: 1 });

    const [row] = await harness.ctx.db
      .select()
      .from(presaleActivities)
      .where(eq(presaleActivities.id, fixture.activityId));
    expect(row?.status).toBe('ended');
    expect(await effectsFor(String(fixture.activityId), 'presale.closed')).toHaveLength(1);

    // SMOKE-011: a second pass is free and changes nothing.
    const second = await sweepPresaleWindows(harness.ctx);
    expect(second).toMatchObject({ scanned: 0, closed: 0 });
    expect(await effectsFor(String(fixture.activityId), 'presale.closed')).toHaveLength(1);
  });

  it('leaves a running campaign alone', async () => {
    const fixture = await makeActivity();
    await sweepPresaleWindows(harness.ctx);
    const [row] = await harness.ctx.db
      .select()
      .from(presaleActivities)
      .where(eq(presaleActivities.id, fixture.activityId));
    expect(row?.status).toBe('active');
  });

  it('records a campaign opening exactly once, and never twice', async () => {
    const fixture = await makeActivity({
      startAt: new Date('2026-05-31T23:00:00.000Z'),
      endAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(await sweepPresaleWindows(harness.ctx)).toMatchObject({ opened: 1 });
    expect(await effectsFor(String(fixture.activityId), 'presale.opened')).toHaveLength(1);
    // A minute later the same campaign is still open; nothing new happened.
    harness.clock.set('2026-06-01T00:01:00.000Z');
    expect(await sweepPresaleWindows(harness.ctx)).toMatchObject({ opened: 0 });
    expect(await effectsFor(String(fixture.activityId), 'presale.opened')).toHaveLength(1);
  });

  it('does not look further back than the configured lookback', async () => {
    // Opened a week ago: outside the 24h window, so the sweep does not rediscover
    // it every minute forever.
    const fixture = await makeActivity({
      startAt: new Date('2026-05-24T00:00:00.000Z'),
      endAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(await sweepPresaleWindows(harness.ctx)).toMatchObject({ opened: 0 });
    expect(await effectsFor(String(fixture.activityId), 'presale.opened')).toHaveLength(0);
  });
});

describe('the admin surface', () => {
  const ADMIN = ['presale:activity:read', 'presale:activity:write', 'presale:activity:delete'];

  const form = (over: Record<string, unknown> = {}) => ({
    productId: '0',
    title: '春茶预售',
    sliderImages: [],
    status: 'draft' as const,
    paymentMode: 'full' as const,
    price: '59.00',
    stock: 100,
    perOrderQuantity: 2,
    startAt: '2026-06-01T00:00:00.000Z',
    endAt: '2026-07-01T00:00:00.000Z',
    shipAfterDays: 15,
    sortOrder: 0,
    skus: [] as { skuId: string; price: string; stock: number; isEnabled: boolean }[],
    ...over,
  });

  it('creates a campaign with its SKU prices and reads it back', async () => {
    const fixture = await makeActivity();
    const ctx = asAdmin(ADMIN);

    const created = await service.adminActivityCreate(
      ctx,
      form({
        productId: String(fixture.productId),
        skus: [{ skuId: String(fixture.skuId), price: '49.00', stock: 30, isEnabled: true }],
      }) as never,
    );

    expect(created).toMatchObject({ title: '春茶预售', status: 'draft', stock: 100, sales: 0 });
    expect(created.skus).toEqual([
      expect.objectContaining({ skuId: String(fixture.skuId), price: '49.00', stock: 30 }),
    ]);

    const detail = await service.adminActivityDetail(ctx, { id: created.id });
    expect(detail.skus).toHaveLength(1);
  });

  it('refuses a SKU that belongs to another product', async () => {
    const fixture = await makeActivity();
    const other = await makeActivity();
    await expect(
      service.adminActivityCreate(
        asAdmin(ADMIN),
        form({
          productId: String(fixture.productId),
          skus: [{ skuId: String(other.skuId), price: '49.00', stock: 5, isEnabled: true }],
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'PRESALE_SKU_NOT_IN_ACTIVITY' });
  });

  it('keeps 已售 across an edit', async () => {
    // Rewriting the row wholesale would zero 已售 every time somebody fixed a
    // typo in the title.
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    await pay(await placeOrder({ userId, fixture }));
    expect((await readCounters(fixture)).activity).toEqual({ stock: 9, sales: 1 });

    const ctx = asAdmin(ADMIN);
    await service.adminActivityUpdate(
      ctx,
      { id: String(fixture.activityId) },
      form({
        productId: String(fixture.productId),
        title: '春茶预售（改名）',
        status: 'active',
        stock: 20,
        skus: [{ skuId: String(fixture.skuId), price: '59.00', stock: 20, isEnabled: true }],
      }) as never,
    );

    const after = await readCounters(fixture);
    // The operator restated how many units are left; what was sold is the
    // server's own total and stays.
    expect(after.activity).toEqual({ stock: 20, sales: 1 });
    expect(after.sku).toEqual({ stock: 20, sales: 1 });
  });

  describe('editing while orders move the stock', () => {
    // The form was opened at 10; a shopper paid for one since, so the rows say 9.
    async function soldOneSinceTheFormOpened() {
      const fixture = await makeActivity({ stock: 10 });
      await pay(await placeOrder({ userId: await makeUser(), fixture }));
      expect((await readCounters(fixture)).activity).toEqual({ stock: 9, sales: 1 });
      return fixture;
    }
    function edit(
      fixture: ActivityFixture,
      stock: { activity: number; sku: number; expected: number },
      status: 'active' | 'ended' = 'active',
      sku: 'kept' | 'removed' | 'switched-off' = 'kept',
    ) {
      return service.adminActivityUpdate(
        asAdmin(ADMIN),
        { id: String(fixture.activityId) },
        form({
          productId: String(fixture.productId),
          title: '春茶预售（改名）',
          status,
          stock: stock.activity,
          expectedStock: stock.expected,
          skus:
            sku === 'removed'
              ? []
              : [
                  {
                    skuId: String(fixture.skuId),
                    price: '59.00',
                    stock: stock.sku,
                    expectedStock: stock.expected,
                    isEnabled: sku === 'kept',
                  },
                ],
        }) as never,
      );
    }

    it('RISK-D-012 — refuses to remove a SKU orders point at, instead of a foreign-key 500', async () => {
      const fixture = await soldOneSinceTheFormOpened();
      await expect(
        edit(fixture, { activity: 10, sku: 10, expected: 10 }, 'active', 'removed'),
      ).rejects.toMatchObject({
        code: 'PRESALE_ACTIVITY_SKU_IN_USE',
        details: { skuIds: [String(fixture.skuId)] },
      });
      await edit(fixture, { activity: 10, sku: 10, expected: 10 }, 'active', 'switched-off');
      expect((await readCounters(fixture)).sku).toEqual({ stock: 9, sales: 1 });
    });

    it('keeps the live stock when the operator only fixed the title', async () => {
      const fixture = await soldOneSinceTheFormOpened();
      await edit(fixture, { activity: 10, sku: 10, expected: 10 });
      const after = await readCounters(fixture);
      expect(after.activity).toEqual({ stock: 9, sales: 1 });
      expect(after.sku).toEqual({ stock: 9, sales: 1 });
    });

    it('refuses a changed stock the form saw before the sale', async () => {
      const fixture = await soldOneSinceTheFormOpened();
      await expect(edit(fixture, { activity: 50, sku: 10, expected: 10 })).rejects.toMatchObject({
        code: 'PRESALE_STOCK_CHANGED',
        details: { expected: 10, current: 9 },
      });
      await expect(edit(fixture, { activity: 10, sku: 50, expected: 10 })).rejects.toMatchObject({
        code: 'PRESALE_STOCK_CHANGED',
        details: { skuId: fixture.skuId, expected: 10, current: 9 },
      });
      expect((await readCounters(fixture)).activity).toEqual({ stock: 9, sales: 1 });
    });

    it('writes a changed stock over the number the form saw', async () => {
      const fixture = await soldOneSinceTheFormOpened();
      await edit(fixture, { activity: 50, sku: 40, expected: 9 });
      const after = await readCounters(fixture);
      expect(after.activity).toEqual({ stock: 50, sales: 1 });
      expect(after.sku).toEqual({ stock: 40, sales: 1 });
    });

    it('does not re-open an ended campaign', async () => {
      const fixture = await makeActivity({ stock: 10, status: 'ended' });
      await expect(edit(fixture, { activity: 10, sku: 10, expected: 10 })).rejects.toMatchObject({
        code: 'PRESALE_ACTIVITY_ENDED',
      });
      // Fixing the copy of an ended campaign is still allowed.
      const kept = await edit(fixture, { activity: 10, sku: 10, expected: 10 }, 'ended');
      expect(kept.status).toBe('ended');
    });
  });

  it('refuses to delete a campaign that still owes a shopper goods', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture });
    const ctx = asAdmin(ADMIN);

    await expect(
      service.adminActivityDelete(ctx, { id: String(fixture.activityId) }),
    ).rejects.toMatchObject({ code: 'PRESALE_ACTIVITY_IN_USE' });

    // Once the order is off the books the campaign can go.
    await cancel(orderId);
    await service.adminActivityDelete(ctx, { id: String(fixture.activityId) });

    const [row] = await harness.ctx.db
      .select()
      .from(presaleActivities)
      .where(eq(presaleActivities.id, fixture.activityId));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.status).toBe('ended');
    await expect(
      service.adminActivityDetail(ctx, { id: String(fixture.activityId) }),
    ).rejects.toMatchObject({ code: 'PRESALE_ACTIVITY_NOT_FOUND' });
  });

  it('will not re-open an ended campaign', async () => {
    const fixture = await makeActivity({ status: 'ended' });
    await expect(
      service.adminActivitySetStatus(
        asAdmin(ADMIN),
        { id: String(fixture.activityId) },
        { status: 'active' },
      ),
    ).rejects.toMatchObject({ code: 'PRESALE_ACTIVITY_NOT_OPEN' });
  });

  it('lists presale orders with the two dates an operator is asked about', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const userId = await makeUser('小红');
    const orderId = await placeOrder({ userId, fixture });
    await pay(orderId);

    const page = await service.adminOrderList(asAdmin(['presale:order:read']), {
      page: 1,
      pageSize: 20,
      activityId: String(fixture.activityId),
    } as never);

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      orderId: String(orderId),
      activityTitle: expect.stringContaining('春茶预售'),
      nickname: '小红',
      stage: 'final_paid',
      quantity: 1,
      finalPaidAt: NOW,
      shipNotBeforeAt: '2026-06-16T00:00:00.000Z',
    });
  });
});

describe('the storefront surface', () => {
  it('shows only campaigns inside their window, and says whether they are buyable', async () => {
    const live = await makeActivity({ stock: 5 });
    await makeActivity({ status: 'draft' });
    await makeActivity({
      startAt: new Date('2026-06-10T00:00:00.000Z'),
      endAt: new Date('2026-06-20T00:00:00.000Z'),
    });
    const soldOut = await makeActivity({ stock: 0 });

    const ctx = asUser(await makeUser());
    const page = await service.list(ctx, { page: 1, pageSize: 20 } as never);

    const byId = new Map(page.items.map((item) => [item.activityId, item]));
    expect(byId.size).toBe(2);
    expect(byId.get(String(live.activityId))?.canBuy).toBe(true);
    // The button is disabled by the same rule the kind handler enforces a moment
    // later — the server's decision, never the client's.
    expect(byId.get(String(soldOut.activityId))?.canBuy).toBe(false);
  });

  it('narrows the list to one product: its live campaigns only, none for a product with none', async () => {
    const shown = await makeActivity();
    await makeActivity();
    const draft = await makeActivity({ status: 'draft' });
    const ctx = asUser(await makeUser());

    const forProduct = await service.list(ctx, {
      page: 1,
      pageSize: 20,
      productId: String(shown.productId),
    });
    expect(forProduct.total).toBe(1);
    expect(forProduct.items.map((item) => item.activityId)).toEqual([String(shown.activityId)]);

    const hidden = await service.list(ctx, {
      page: 1,
      pageSize: 20,
      productId: String(draft.productId),
    });
    expect(hidden).toMatchObject({ total: 0, items: [] });
  });

  it('answers a manual pick by id, in the given order, with only what the list would show', async () => {
    const first = await makeActivity({ stock: 5 });
    const second = await makeActivity({ stock: 0 });
    const draft = await makeActivity({ status: 'draft' });
    const later = await makeActivity({
      startAt: new Date('2026-06-10T00:00:00.000Z'),
      endAt: new Date('2026-06-20T00:00:00.000Z'),
    });
    const deleted = await makeActivity();
    await harness.ctx.db
      .update(presaleActivities)
      .set({ deletedAt: harness.clock.now() })
      .where(eq(presaleActivities.id, deleted.activityId));

    const ids = [second, draft, later, deleted, first].map((f) => String(f.activityId));
    const cards = await service.cardsFor(harness.ctx, [...ids, 'abc', ids[0]!]);

    expect(cards.map((card) => card.activityId)).toEqual([
      String(second.activityId),
      String(first.activityId),
    ]);
    const listed = await service.list(harness.ctx, { page: 1, pageSize: 20 } as never);
    for (const card of cards) {
      expect(card).toEqual(listed.items.find((item) => item.activityId === card.activityId));
    }
    expect(await service.cardsFor(harness.ctx, [])).toEqual([]);
  });

  it('finds a picked campaign however many campaigns come before it in the list', async () => {
    const picked = await makeActivity();
    await harness.ctx.db
      .update(presaleActivities)
      .set({ sortOrder: -1 })
      .where(eq(presaleActivities.id, picked.activityId));
    for (let index = 0; index < 3; index += 1) await makeActivity();

    const firstPage = await service.list(harness.ctx, { page: 1, pageSize: 3 } as never);
    expect(firstPage.items.map((card) => card.activityId)).not.toContain(String(picked.activityId));
    const cards = await service.cardsFor(harness.ctx, [String(picked.activityId)]);
    expect(cards.map((card) => card.activityId)).toEqual([String(picked.activityId)]);
  });

  it('serves the detail with enabled SKUs only and the catalogue price struck through', async () => {
    const fixture = await makeActivity({ stock: 5 });
    const ctx = asUser(await makeUser());
    const detail = await service.detail(ctx, { id: String(fixture.activityId) });

    expect(detail).toMatchObject({ canBuy: true, perOrderQuantity: 2, shipAfterDays: 15 });
    expect(detail.skus).toEqual([
      expect.objectContaining({
        skuId: String(fixture.skuId),
        price: '59.00',
        originalPrice: '108.00',
        stock: 5,
      }),
    ]);

    await harness.ctx.db
      .update(presaleActivitySkus)
      .set({ isEnabled: false })
      .where(eq(presaleActivitySkus.activityId, fixture.activityId));
    expect((await service.detail(ctx, { id: String(fixture.activityId) })).skus).toHaveLength(0);
  });

  it('404s a draft by id, and keeps a paused or ended campaign readable but not buyable', async () => {
    const ctx = asUser(await makeUser());
    const draft = await makeActivity({ status: 'draft' });
    await expect(service.detail(ctx, { id: String(draft.activityId) })).rejects.toMatchObject({
      code: 'PRESALE_ACTIVITY_NOT_FOUND',
    });

    for (const status of ['paused', 'ended'] as const) {
      const fixture = await makeActivity({ status, stock: 5 });
      const detail = await service.detail(ctx, { id: String(fixture.activityId) });
      expect(detail.canBuy, status).toBe(false);
    }
  });

  it('hides a deleted campaign from the detail route', async () => {
    const fixture = await makeActivity();
    await harness.ctx.db
      .update(presaleActivities)
      .set({ deletedAt: harness.clock.now() })
      .where(eq(presaleActivities.id, fixture.activityId));
    await expect(
      service.detail(asUser(await makeUser()), { id: String(fixture.activityId) }),
    ).rejects.toMatchObject({ code: 'PRESALE_ACTIVITY_NOT_FOUND' });
  });
});

describe('the system refund seam', () => {
  /** Two orders, a quota of one: the second payment is the one that needs it. */
  async function loseTheQuota(): Promise<number> {
    const fixture = await makeActivity({ stock: 10, totalQuota: 1 });
    const first = await placeOrder({ userId: await makeUser(), fixture });
    const second = await placeOrder({ userId: await makeUser(), fixture });
    await pay(first);
    await pay(second);
    return second;
  }

  /** Drains every `presale.refund` effect the order has, the way the dispatcher does. */
  async function driveRefundEffects(orderId: number): Promise<void> {
    const handler = await import('../effects/index').then((m) =>
      m.getEffectHandler('order', 'presale.refund'),
    );
    for (const row of await effectsFor(String(orderId), 'presale.refund')) {
      await handler!(harness.ctx, {
        id: row.id,
        scope: row.scope,
        scopeId: row.scopeId,
        eventType: row.eventType,
        payload: row.payload,
        attempts: 1,
      });
    }
  }

  const refundsFor = (orderId: number) =>
    harness.ctx.db.select().from(refunds).where(eq(refunds.orderId, orderId));

  it('gives the shopper exactly one refund, however many callbacks arrive', async () => {
    const orderId = await loseTheQuota();
    // Two more payment callbacks and two more drains: four chances to refund
    // the same order twice. `UNIQUE (scope, scope_id, event_type)` makes one
    // effect, and `refundSystemInitiated` is idempotent per (order, reason) on
    // top of that.
    await pay(orderId);
    await pay(orderId);
    await driveRefundEffects(orderId);
    await driveRefundEffects(orderId);

    const rows = await refundsFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'approved',
      isAutomatic: true,
      reason: '预售未成行，系统自动退款',
      amount: '59.00',
      reviewedByAdminId: null,
    });

    // And the gateway call is queued once, post-commit, like every other.
    const queued = await harness.ctx.db
      .select()
      .from(effects)
      .where(eq(effects.scopeId, String(rows[0]!.id)));
    expect(queued.filter((row) => row.eventType === 'refund.execute')).toHaveLength(1);
  });

  it('refunds nobody whose payment the campaign could honour', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const orderId = await placeOrder({ userId: await makeUser(), fixture });
    await pay(orderId);

    expect(await effectsFor(String(orderId), 'presale.refund')).toHaveLength(0);
    expect(await refundsFor(orderId)).toHaveLength(0);
  });

  it('lets a test substitute the refund seam', async () => {
    const seen: Array<{ orderId: number; reason: string }> = [];
    registerAutoRefundPort({
      async refund(_tx, _ctx, input) {
        seen.push({ orderId: input.orderId, reason: input.reason });
        return { refundId: 77, created: true };
      },
    });

    const orderId = await loseTheQuota();
    await driveRefundEffects(orderId);

    expect(seen).toEqual([{ orderId, reason: 'presale_expired' }]);
    expect(await refundsFor(orderId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// shopper notifications
// ---------------------------------------------------------------------------

/**
 * What a presale shopper is told, end to end: the presale effect records the
 * notice, the notification effect fans it out, and the channels the operator
 * switched on receive the rendered payload. WeChat is the fake
 * `api.weixin.qq.com` from `@shop/testing`; SMS is a recording port.
 */
describe('shopper notifications', () => {
  let oa: FakeOaServer;
  const sms: { calls: Parameters<SmsPort['send']>[1][] } = { calls: [] };
  const superAdmin = (): Ctx =>
    harness.as({ kind: 'admin', id: 1, permissions: [], isSuper: true });
  const SEND = 'notification.send';

  beforeAll(async () => {
    oa = await startFakeOaServer();
    process.env['PUBLIC_ORIGIN'] = 'https://shop.example.test';
  });

  afterAll(async () => {
    delete process.env['PUBLIC_ORIGIN'];
    await oa?.close();
  });

  beforeEach(async () => {
    await harness.redis.flushdb();
    oa.reset();
    resetWechatTokenFlight();
    sms.calls = [];
    registerSmsPort({
      async send(_ctx, input) {
        sms.calls.push(input);
        return { ok: true };
      },
    });
    await harness.ctx.config.set(wechatConfig, {
      oaAppId: oa.appId,
      oaAppSecret: oa.appSecret,
      apiBaseUrl: oa.url,
    });
  });

  /**
   * Runs the pending effects of the named types, and the ones they record —
   * only those: `refund.execute` would call the payment gateway, and this suite
   * is about what the shopper is told.
   */
  async function runEffects(types: readonly string[]): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      const due = await harness.ctx.db
        .select()
        .from(effects)
        .where(and(eq(effects.status, 'pending'), inArray(effects.eventType, [...types])));
      if (due.length === 0) return;
      for (const row of due) {
        await getEffectHandler(row.scope, row.eventType)!(harness.ctx, {
          id: row.id,
          scope: row.scope,
          scopeId: row.scopeId,
          eventType: row.eventType,
          payload: row.payload,
          attempts: 1,
        });
        await harness.ctx.db.update(effects).set({ status: 'done' }).where(eq(effects.id, row.id));
      }
    }
    throw new Error('effects kept recording effects');
  }

  const inbox = (userId: number) =>
    harness.ctx.db
      .select()
      .from(notificationMessages)
      .where(eq(notificationMessages.userId, userId));

  async function orderOf(orderId: number) {
    const [row] = await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    return row!;
  }

  async function titleOf(fixture: ActivityFixture): Promise<string> {
    const [row] = await harness.ctx.db
      .select({ title: presaleActivities.title })
      .from(presaleActivities)
      .where(eq(presaleActivities.id, fixture.activityId));
    return row!.title;
  }

  it('tells the shopper the ship date their payment fixed, once, on every channel switched on', async () => {
    const current = await notificationAdmin.getTemplate(superAdmin(), { code: 'presale_paid' });
    await notificationAdmin.saveTemplate(
      superAdmin(),
      { code: 'presale_paid' },
      {
        isEnabled: true,
        channels: {
          ...current.channels,
          wechatOa: {
            enabled: true,
            templateKey: 'OPENTM2',
            templateId: 'TPL_OA_PRESALE',
            fields: { keyword1: '{{orderNo}}', keyword2: '{{shipDate}}' },
          },
          // A template with no variables sends none.
          sms: { enabled: true, templateCode: 'SMS_PRESALE', params: [] },
        },
      },
    );

    // Paid at 20:00 UTC on 1 June, which is already 2 June in the shop; 15 days
    // on from there is 17 June.
    harness.clock.set('2026-06-01T20:00:00.000Z');
    const fixture = await makeActivity({ shipAfterDays: 15 });
    const userId = await makeUser();
    const orderId = await placeOrder({ userId, fixture });
    await pay(orderId);
    await harness.ctx.db
      .insert(wechatIdentities)
      .values({ userId, platform: 'oa', openid: 'oa-presale-1' });

    await runEffects(['presale.paid', SEND]);
    // A replayed payment callback records nothing new, and a re-run effect
    // finds its notice already there.
    await pay(orderId);
    await harness.ctx.db
      .update(effects)
      .set({ status: 'pending' })
      .where(eq(effects.eventType, 'presale.paid'));
    await runEffects(['presale.paid', SEND]);

    const { orderNo } = await orderOf(orderId);
    const title = await titleOf(fixture);
    const messages = await inbox(userId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ code: 'presale_paid', title: '预售付款成功' });
    expect(messages[0]?.content).toBe(
      `您预订的「${title}」已付款 ¥59.00，将于 2026-06-17 起发货。`,
    );
    expect(messages[0]?.data).toMatchObject({
      route: { route: 'order', params: { id: String(orderId) } },
    });

    const sends = oa.callsTo('/cgi-bin/message/template/send');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toEqual({
      touser: 'oa-presale-1',
      template_id: 'TPL_OA_PRESALE',
      data: { keyword1: { value: orderNo }, keyword2: { value: '2026-06-17' } },
    });
    expect(sms.calls).toEqual([
      expect.objectContaining({
        userId,
        templateCode: 'SMS_PRESALE',
        notificationCode: 'presale_paid',
        params: [],
      }),
    ]);
  });

  it('tells a shopper whose payment the quota refused, in the transaction that opened the refund', async () => {
    const fixture = await makeActivity({ stock: 10, totalQuota: 1 });
    const firstUser = await makeUser();
    const first = await placeOrder({ userId: firstUser, fixture });
    const secondUser = await makeUser();
    const second = await placeOrder({ userId: secondUser, fixture });
    await pay(first);
    await pay(second);

    // Nothing is said about the refused payment until its refund is open.
    await runEffects(['presale.paid', 'presale.released', SEND]);
    expect(await inbox(secondUser)).toHaveLength(0);
    expect((await inbox(firstUser)).map((row) => row.code)).toEqual(['presale_paid']);

    await runEffects(['presale.refund', SEND]);

    const [refundRow] = await harness.ctx.db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, second));
    expect(refundRow).toBeDefined();
    const messages = await inbox(secondUser);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ code: 'presale_sold_out', title: '预售名额已满' });
    expect(messages[0]?.content).toBe(
      `「${await titleOf(fixture)}」的预售名额已满，订单 ${(await orderOf(second)).orderNo} 的 ¥59.00 将原路退回。`,
    );
    expect(messages[0]?.data).toMatchObject({ refundId: String(refundRow!.id) });
  });

  it('sends nothing for an event the operator switched off in 通知管理', async () => {
    const current = await notificationAdmin.getTemplate(superAdmin(), { code: 'presale_paid' });
    await notificationAdmin.saveTemplate(
      superAdmin(),
      { code: 'presale_paid' },
      { isEnabled: false, channels: current.channels },
    );

    const fixture = await makeActivity();
    const userId = await makeUser();
    await pay(await placeOrder({ userId, fixture }));
    await runEffects(['presale.paid', SEND]);

    expect(await inbox(userId)).toHaveLength(0);
    expect(sms.calls).toHaveLength(0);
  });

  it('lists both events in 通知管理 with in-app on and the registry wording', async () => {
    const page = await notificationAdmin.listTemplates(superAdmin(), {
      page: 1,
      pageSize: 50,
      keyword: 'presale_',
    });
    expect(page.items.map((row) => row.code)).toEqual(['presale_paid', 'presale_sold_out']);
    for (const row of page.items) {
      expect(row.channels.inApp?.enabled).toBe(true);
      expect(row.supportedChannels).toEqual(['inApp', 'wechatOa', 'wechatMini', 'sms']);
    }
  });
});
