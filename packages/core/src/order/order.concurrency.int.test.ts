import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, products } from '@shop/db/schema/catalog';
import { couponTemplates, userCoupons } from '@shop/db/schema/coupon';
import { orders } from '@shop/db/schema/order';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import { registerCatalogDomain, stockAndSalesOf } from '../catalog';
import { registerShippingFreightPort } from '../shipping';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { withTx } from '../kernel/tx';
import * as order from './index';
import * as repo from './order.repo';
import { orderStateMachine } from './order.state-machine';
import { registerOrderStateMachine, resetOrderPorts } from './ports';

/**
 * The races.
 *
 * Every conditional state change in checkout and cancellation owes one: the
 * last unit of stock, the duplicate submit, cancel against the paid transition,
 * one coupon against two orders, and the auto-cancel against the shopper's own
 * tap.
 *
 * What makes them real rather than decorative:
 *
 *  - `runConcurrently` releases every caller from a single barrier, so they
 *    collide inside the same statement instead of politely queueing;
 *  - every caller gets its own `Ctx` from `forkTestCtx`, so they hold
 *    *different* pooled connections. Sharing one would serialise them and each
 *    assertion below would pass for the wrong reason;
 *  - `isWinner` reads the outcome flag, never truthiness: the default would
 *    count `{ won: false }` as a win and prove nothing at all.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';
const AFTER_WINDOW = '2026-06-01T00:31:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, platform: 'h5' });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  harness.queue.reset();
  resetOrderPorts();
  registerCatalogDomain();
  registerShippingFreightPort();
  registerOrderStateMachine(orderStateMachine);
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let sequence = 0;

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });

/** A caller with its own connection pool, acting as this shopper. */
function racer(userId: number): Ctx {
  return forkTestCtx(harness, { actor: userActor(userId), platform: 'h5' });
}

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `race-${sequence}` })
    .returning({ id: users.id });
  const userId = row!.id;
  await harness.ctx.db.insert(userAddresses).values({
    userId,
    receiverName: '张三',
    receiverPhone: '13800138000',
    provinceName: '浙江省',
    cityName: '杭州市',
    detail: '文三路 100 号',
    isDefault: true,
  });
  return userId;
}

async function makeProduct(stock: number): Promise<{ productId: number; skuId: number }> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      price: '60.00',
      stock,
      freightMode: 'free',
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SKU-${sequence}`,
      specText: '默认',
      price: '60.00',
      stock,
      isDefault: true,
    })
    .returning({ id: productSkus.id });
  return { productId: product!.id, skuId: sku!.id };
}

async function addToCart(
  userId: number,
  line: { productId: number; skuId: number },
  quantity = 1,
): Promise<number> {
  const [row] = await harness.ctx.db
    .insert(cartItems)
    .values({ userId, productId: line.productId, skuId: line.skuId, quantity, isSelected: true })
    .returning({ id: cartItems.id });
  return row!.id;
}

async function makeCoupon(userId: number): Promise<number> {
  sequence += 1;
  const [template] = await harness.ctx.db
    .insert(couponTemplates)
    .values({
      name: `券${sequence}`,
      status: 'active',
      claimMode: 'manual',
      discountAmount: '10.00',
      minSpend: '0.00',
      validityMode: 'days_after_claim',
      validDays: 30,
      isUnlimitedSupply: true,
      perUserLimit: 1,
    })
    .returning({ id: couponTemplates.id });
  const [wallet] = await harness.ctx.db
    .insert(userCoupons)
    .values({
      templateId: template!.id,
      userId,
      claimSlot: 1,
      sourceKind: 'claim',
      title: `券${sequence}`,
      discountAmount: '10.00',
      minSpend: '0.00',
      status: 'unused',
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: new Date('2026-12-31T00:00:00.000Z'),
    })
    .returning({ id: userCoupons.id });
  return wallet!.id;
}

const key = () => `race-${(sequence += 1).toString().padStart(10, '0')}`;

interface Attempt {
  won: boolean;
  orderId?: string;
  code?: string;
}

/** Turns `create` into a `{ won }` outcome so `isWinner` has something honest to read. */
async function attemptCreate(ctx: Ctx, body: Parameters<typeof order.create>[1]): Promise<Attempt> {
  try {
    const detail = await order.create(ctx, body);
    return { won: true, orderId: detail.id };
  } catch (error) {
    if (DomainError.is(error)) return { won: false, code: error.code };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// STOCK-001 — the last unit
// ---------------------------------------------------------------------------

describe('two checkouts for the last unit', () => {
  it('sells it exactly once', async () => {
    const item = await makeProduct(1);
    const buyers = await Promise.all([makeUser(), makeUser()]);
    for (const userId of buyers) await addToCart(userId, item, 1);

    const report = await runConcurrently(
      buyers.length,
      (index) =>
        attemptCreate(racer(buyers[index]!), {
          source: 'cart',
          cartItemIds: [],
          kind: 'normal',
          idempotencyKey: key(),
        }),
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);
    expect(report.fulfilled.filter((o) => !o.won).map((o) => o.code)).toEqual([
      'ORDER_OUT_OF_STOCK',
    ]);

    expect(await stockAndSalesOf(harness.ctx.db, item.skuId)).toEqual({ stock: 0, sales: 0 });
    expect(await harness.ctx.db.select().from(orders)).toHaveLength(1);
    // The loser's cart row survives, because its whole transaction rolled back.
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(1);
  });

  it('sells ten units to exactly ten of twelve buyers', async () => {
    const item = await makeProduct(10);
    const buyers = await Promise.all(Array.from({ length: 12 }, () => makeUser()));
    for (const userId of buyers) await addToCart(userId, item, 1);

    const report = await runConcurrently(
      buyers.length,
      (index) =>
        attemptCreate(racer(buyers[index]!), {
          source: 'cart',
          cartItemIds: [],
          kind: 'normal',
          idempotencyKey: key(),
        }),
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(10);
    expect(report.losers).toBe(2);
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(0);
  });

  it('hands back every line it already took when a later line is short', async () => {
    // Two lines, the second of which cannot be satisfied: the first must not
    // be left decremented (ORDER-008).
    const plenty = await makeProduct(10);
    const scarce = await makeProduct(0);
    const userId = await makeUser();
    await addToCart(userId, plenty, 1);
    await addToCart(userId, scarce, 1);

    const outcome = await attemptCreate(racer(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      idempotencyKey: key(),
    });

    expect(outcome).toMatchObject({ won: false, code: 'ORDER_OUT_OF_STOCK' });
    expect((await stockAndSalesOf(harness.ctx.db, plenty.skuId)).stock).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// ORDER-002 — the duplicate submit
// ---------------------------------------------------------------------------

describe('the same idempotency key submitted several times at once', () => {
  it('creates exactly one order and answers every caller with it', async () => {
    const item = await makeProduct(50);
    const userId = await makeUser();
    await addToCart(userId, item, 1);
    const sharedKey = key();

    const report = await runConcurrently(
      6,
      () =>
        attemptCreate(racer(userId), {
          source: 'cart',
          cartItemIds: [],
          kind: 'normal',
          idempotencyKey: sharedKey,
        }),
      { isWinner: (outcome) => outcome.won },
    );

    // Every caller succeeds — that is the point of idempotency, not that five
    // of them get an error.
    expect(report.winners).toBe(6);
    const ids = new Set(report.fulfilled.map((outcome) => outcome.orderId));
    expect(ids.size).toBe(1);

    const stored = await harness.ctx.db.select().from(orders);
    expect(stored).toHaveLength(1);
    // The key rode in on that one row; the unique index is what refused the
    // other five.
    expect(stored[0]?.idempotencyKey).toBe(sharedKey);
    // One order, one unit of stock.
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(49);
    // And exactly one auto-cancel, and one reminder, scheduled.
    expect(harness.queue.jobs.filter((job) => job.jobName === 'order.autoCancel')).toHaveLength(1);
    expect(harness.queue.jobs.filter((job) => job.jobName === 'order.remindUnpaid')).toHaveLength(
      1,
    );
  });

  it('lets a key be reused after the order it was claiming rolled back', async () => {
    const item = await makeProduct(1);
    const userId = await makeUser();
    await addToCart(userId, item, 5); // more than the stock: this submit fails
    const sharedKey = key();

    const failed = await attemptCreate(racer(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      idempotencyKey: sharedKey,
    });
    expect(failed.won).toBe(false);
    // Nothing survives a rolled-back submit, so the key is free again.
    expect(await harness.ctx.db.select().from(orders)).toHaveLength(0);
    expect(
      await repo.findOrderIdByIdempotencyKey(harness.ctx.db, { userId, key: sharedKey }),
    ).toBeNull();

    await harness.ctx.db.update(cartItems).set({ quantity: 1 }).where(eq(cartItems.userId, userId));
    const retried = await attemptCreate(racer(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      idempotencyKey: sharedKey,
    });
    expect(retried.won).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QUEUE-004 — cancel against the paid transition
// ---------------------------------------------------------------------------

describe('cancel racing the paid transition', () => {
  async function liveOrder(): Promise<{ userId: number; orderId: number; skuId: number }> {
    const item = await makeProduct(10);
    const userId = await makeUser();
    await addToCart(userId, item, 2);
    const detail = await order.create(racer(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      idempotencyKey: key(),
    });
    harness.queue.reset();
    return { userId, orderId: Number(detail.id), skuId: item.skuId };
  }

  /** What the payment domain does inside its own transaction when the callback lands. */
  async function markPaid(ctx: Ctx, orderId: number): Promise<Attempt> {
    return withTx(ctx.db, async (tx) => {
      const moved = await orderStateMachine.transition(tx, orderId, ['pending_payment'], 'paid', {
        at: ctx.clock.now(),
        paidAmount: '120.00',
        transactionNo: 'WX-RACE',
      });
      return { won: moved.won };
    });
  }

  it('lets exactly one of them through', async () => {
    const { userId, orderId, skuId } = await liveOrder();
    const cancelCtx = racer(userId);
    const payCtx = racer(userId);

    const report = await runConcurrently<Attempt>(
      2,
      async (index) => {
        if (index === 0) {
          try {
            await order.cancel(cancelCtx, { id: String(orderId) }, {});
            return { won: true, code: 'cancelled' };
          } catch (error) {
            if (DomainError.is(error)) return { won: false, code: error.code };
            throw error;
          }
        }
        return markPaid(payCtx, orderId);
      },
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);

    const [row] = await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    const stock = (await stockAndSalesOf(harness.ctx.db, skuId)).stock;

    if (row!.status === 'cancelled') {
      // The cancellation won: the stock came back and no money was recorded.
      expect(stock).toBe(10);
      expect(row!.paidAt).toBeNull();
    } else {
      // The payment won: the order is paid and the stock stays committed.
      expect(row!.status).toBe('paid');
      expect(stock).toBe(8);
      expect(row!.cancelledAt).toBeNull();
    }
  });

  it('refuses the cancellation outright when the gateway reports the money arrived', async () => {
    const { userId, orderId, skuId } = await liveOrder();
    const { fakePaymentPort } = await import('@shop/testing');
    const { registerPaymentPort } = await import('./ports');
    registerPaymentPort(fakePaymentPort({ result: 'paid' }));

    const report = await runConcurrently<Attempt>(
      3,
      async () => {
        try {
          await order.cancel(racer(userId), { id: String(orderId) }, {});
          return { won: true };
        } catch (error) {
          if (DomainError.is(error)) return { won: false, code: error.code };
          throw error;
        }
      },
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(0);
    expect(new Set(report.fulfilled.map((o) => o.code))).toEqual(new Set(['ORDER_ALREADY_PAID']));
    // Nothing released, by any of the three.
    expect((await stockAndSalesOf(harness.ctx.db, skuId)).stock).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// COUPON-006 — one coupon, two orders
// ---------------------------------------------------------------------------

describe('one coupon spent by two orders at once', () => {
  it('is redeemed once, and the losing order does not exist', async () => {
    const item = await makeProduct(10);
    const userId = await makeUser();
    await addToCart(userId, item, 1);
    const couponId = await makeCoupon(userId);

    const report = await runConcurrently(
      2,
      () =>
        attemptCreate(racer(userId), {
          source: 'buy-now',
          cartItemIds: [],
          item: { skuId: String(item.skuId), quantity: 1 },
          kind: 'normal',
          userCouponId: String(couponId),
          idempotencyKey: key(),
        }),
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);
    expect(report.fulfilled.filter((o) => !o.won).map((o) => o.code)).toEqual([
      'COUPON_NOT_USABLE',
    ]);

    const [wallet] = await harness.ctx.db
      .select()
      .from(userCoupons)
      .where(eq(userCoupons.id, couponId));
    expect(wallet?.status).toBe('used');

    const rows = await harness.ctx.db.select().from(orders);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userCouponId).toBe(couponId);
    // The loser rolled its reservation back with the rest of its transaction.
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// QUEUE-006 — the auto-cancel against the shopper's own tap
// ---------------------------------------------------------------------------

describe('auto-cancel racing the user cancel', () => {
  it('cancels once, returns the stock once and returns the coupon once', async () => {
    const item = await makeProduct(10);
    const userId = await makeUser();
    await addToCart(userId, item, 2);
    const couponId = await makeCoupon(userId);
    const detail = await order.create(racer(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      userCouponId: String(couponId),
      idempotencyKey: key(),
    });
    const orderId = Number(detail.id);
    harness.clock.set(AFTER_WINDOW);

    const report = await runConcurrently<Attempt>(
      2,
      async (index) => {
        if (index === 0) {
          const outcome = await order.autoCancel(racer(userId), { orderId });
          return { won: outcome.cancelled, code: 'timeout' };
        }
        try {
          await order.cancel(racer(userId), { id: String(orderId) }, { reason: '不想要了' });
          return { won: true, code: 'user' };
        } catch (error) {
          if (DomainError.is(error)) return { won: false, code: error.code };
          throw error;
        }
      },
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);

    const [row] = await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row?.status).toBe('cancelled');
    // Exactly one release of each, not two.
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(10);
    const [wallet] = await harness.ctx.db
      .select()
      .from(userCoupons)
      .where(eq(userCoupons.id, couponId));
    expect(wallet?.status).toBe('unused');
  });

  it('survives the sweep and the shopper arriving together on many orders', async () => {
    const item = await makeProduct(100);
    const userId = await makeUser();
    const created: number[] = [];
    for (let n = 0; n < 5; n += 1) {
      await addToCart(userId, item, 1);
      const detail = await order.create(racer(userId), {
        source: 'cart',
        cartItemIds: [],
        kind: 'normal',
        idempotencyKey: key(),
      });
      created.push(Number(detail.id));
    }
    harness.clock.set(AFTER_WINDOW);

    await runConcurrently(2, async (index) => {
      if (index === 0) return order.sweepExpiredOrders(racer(userId));
      for (const orderId of created) {
        await order.cancel(racer(userId), { id: String(orderId) }, {}).catch(() => undefined);
      }
      return { scanned: 0, cancelled: 0 };
    });

    const rows = await harness.ctx.db.select().from(orders);
    expect(rows.every((row) => row.status === 'cancelled')).toBe(true);
    // Five orders, five units, every one of them back exactly once.
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(100);
  });
});
