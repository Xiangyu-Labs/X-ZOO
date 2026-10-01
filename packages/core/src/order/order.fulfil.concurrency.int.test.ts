import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, productVirtualCards, products } from '@shop/db/schema/catalog';
import { orderItems, orderStatusLogs, orders, shipments } from '@shop/db/schema/order';
import { expressCompanies } from '@shop/db/schema/reference';
import { admins } from '@shop/db/schema/auth';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import { registerCatalogDomain } from '../catalog';
import { registerShippingFreightPort } from '../shipping';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { Money } from '../kernel/money';
import { conditionalUpdate, withTx } from '../kernel/tx';
import * as order from './index';
import { autoDeliver, installFulfilmentHooks } from './order.fulfil.effects';
import { resetFulfilmentPorts } from './order.fulfil.ports';
import { orderStateMachine } from './order.state-machine';
import {
  onOrderPaid,
  onShipmentDispatched,
  registerOrderStateMachine,
  resetOrderPorts,
} from './ports';

/**
 * The fulfilment races.
 *
 * Four of them, and each one goes wrong the moment a row is read and then
 * written:
 *
 *  1. two operators pressing 发货 on the same order at the same moment;
 *  2. the buyer's 确认收货 landing at the same moment as the auto-receive job;
 *  3. a dispatch racing a refund approval for the same line;
 *  4. two effect dispatchers replaying the same virtual delivery.
 *
 * What makes them real rather than decorative is the same three things
 * `order.concurrency.int.test.ts` relies on: `runConcurrently` releases every
 * caller from one barrier, every caller gets its own pooled connection from
 * `forkTestCtx`, and `isWinner` reads an explicit outcome flag instead of
 * truthiness.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';

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
  resetFulfilmentPorts();
  registerOrderStateMachine(orderStateMachine);
  installFulfilmentHooks();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let sequence = 0;

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const adminActor = (id: number): Actor => ({ kind: 'admin', id, permissions: [], isSuper: true });

const as = (userId: number): Ctx => harness.as(userActor(userId));
const asAdmin = (adminId: number): Ctx => harness.as(adminActor(adminId));

/** A caller with its own pooled connection, so the two really collide. */
const racerAdmin = (adminId: number): Ctx =>
  forkTestCtx(harness, { actor: adminActor(adminId), platform: null });
const racerUser = (userId: number): Ctx =>
  forkTestCtx(harness, { actor: userActor(userId), platform: 'h5' });
const racerSystem = (): Ctx => forkTestCtx(harness, { platform: null });

async function makeAdmin(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(admins)
    .values({ account: `op-${sequence}`, passwordHash: 'x', name: `操作员${sequence}` })
    .returning({ id: admins.id });
  return row!.id;
}

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `buyer-${sequence}` })
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

type Kind = 'physical' | 'virtual_card' | 'virtual_coupon' | 'virtual_manual';

async function makeProduct(kind: Kind = 'physical'): Promise<{ productId: number; skuId: number }> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      kind,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      price: '60.00',
      stock: 100,
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
      stock: 100,
      isDefault: true,
    })
    .returning({ id: productSkus.id });
  return { productId: product!.id, skuId: sku!.id };
}

async function makeCards(line: { productId: number; skuId: number }, count: number): Promise<void> {
  if (count === 0) return;
  await harness.ctx.db.insert(productVirtualCards).values(
    Array.from({ length: count }, () => {
      sequence += 1;
      return {
        productId: line.productId,
        skuId: line.skuId,
        cardKey: `KEY-${sequence}`,
        cardNo: `NO-${sequence}`,
      };
    }),
  );
}

async function makeExpressCompany(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(expressCompanies)
    .values({ code: `sf-${sequence}`, name: `顺丰${sequence}` })
    .returning({ id: expressCompanies.id });
  return row!.id;
}

const key = () => `race-${(sequence += 1).toString().padStart(10, '0')}`;

interface Placed {
  userId: number;
  orderId: number;
  itemIds: number[];
}

async function paidOrder(
  lines: { productId: number; skuId: number; quantity?: number }[],
): Promise<Placed> {
  const userId = await makeUser();
  for (const line of lines) {
    await harness.ctx.db.insert(cartItems).values({
      userId,
      productId: line.productId,
      skuId: line.skuId,
      quantity: line.quantity ?? 1,
      isSelected: true,
    });
  }
  const detail = await order.create(as(userId), {
    source: 'cart',
    cartItemIds: [],
    kind: 'normal',
    idempotencyKey: key(),
  });
  const orderId = Number(detail.id);
  await withTx(harness.ctx.db, async (tx) => {
    const moved = await orderStateMachine.transition(tx, orderId, ['pending_payment'], 'paid', {
      at: harness.ctx.clock.now(),
      paidAmount: '60.00',
      transactionNo: `WX-${orderId}`,
    });
    if (!moved.won) throw new Error('could not pay');
    const [row] = await tx.select().from(orders).where(eq(orders.id, orderId));
    await onOrderPaid.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: row!.orderNo,
      userId: row!.userId,
      paidAmount: Money.parse('60.00'),
      at: harness.ctx.clock.now(),
    });
  });
  const items = await harness.ctx.db
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.id);
  harness.queue.reset();
  return { userId, orderId, itemIds: items.map((item) => item.id) };
}

const orderRow = async (orderId: number) =>
  (await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId)))[0]!;

const itemRow = async (id: number) =>
  (await harness.ctx.db.select().from(orderItems).where(eq(orderItems.id, id)))[0]!;

interface Attempt {
  won: boolean;
  code?: string;
}

async function attempt(run: () => Promise<unknown>): Promise<Attempt> {
  try {
    await run();
    return { won: true };
  } catch (error) {
    if (DomainError.is(error)) return { won: false, code: error.code };
    throw error;
  }
}

const shipBody = (companyId: number, lines: { orderItemId: string; quantity: number }[] = []) => ({
  deliveryMode: 'express' as const,
  expressCompanyId: String(companyId),
  trackingNo: `SF-${(sequence += 1).toString()}`,
  lines,
});

/**
 * What the refund domain does when a refund is approved: take units off the
 * line under the mirror of the ship bound. Written here rather than imported so
 * the test isolates the two bounds — the point is that the dispatch bound holds
 * *against* it, whichever of the two commits first.
 */
async function approveRefund(ctx: Ctx, args: { orderItemId: number; quantity: number }) {
  return withTx(ctx.db, async (tx) =>
    conditionalUpdate(tx, orderItems, {
      where: and(
        eq(orderItems.id, args.orderItemId),
        sql`${orderItems.refundedQuantity} + ${args.quantity} <= ${orderItems.quantity} - ${orderItems.shippedQuantity}`,
      ),
      set: {
        refundedQuantity: sql`${orderItems.refundedQuantity} + ${args.quantity}`,
        updatedAt: sql`now()`,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// FULFILL-001 — two operators pressing 发货
// ---------------------------------------------------------------------------

describe('two operators shipping the same order at once', () => {
  it('dispatches it exactly once', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([{ ...product, quantity: 2 }]);
    const first = await makeAdmin();
    const second = await makeAdmin();

    const report = await runConcurrently<Attempt>(
      2,
      (index) =>
        attempt(() =>
          order.adminShip(
            racerAdmin(index === 0 ? first : second),
            { id: String(placed.orderId) },
            shipBody(company),
          ),
        ),
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);
    // The loser is told the order is no longer shippable, not given a stack trace.
    expect(report.fulfilled.filter((o) => !o.won).map((o) => o.code)).toEqual([
      'ORDER_NOT_SHIPPABLE',
    ]);

    expect(await harness.ctx.db.select().from(shipments)).toHaveLength(1);
    expect((await itemRow(placed.itemIds[0]!)).shippedQuantity).toBe(2);
    const row = await orderRow(placed.orderId);
    expect(row.status).toBe('shipped');
    expect(row.fulfillmentStatus).toBe('fulfilled');
    // One dispatch, one auto-receive.
    expect(harness.queue.jobs.filter((job) => job.jobName === 'order.autoReceive')).toHaveLength(1);
  });

  it('lets two operators split one line without ever overshipping it', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    // Four units, six operators each trying to send two.
    const placed = await paidOrder([{ ...product, quantity: 4 }]);
    const adminId = await makeAdmin();

    const report = await runConcurrently<Attempt>(
      6,
      () =>
        attempt(() =>
          order.adminShip(
            racerAdmin(adminId),
            { id: String(placed.orderId) },
            shipBody(company, [{ orderItemId: String(placed.itemIds[0]), quantity: 2 }]),
          ),
        ),
      { isWinner: (outcome) => outcome.won },
    );

    // Whoever won, the line is never past four and the order is consistent.
    expect(report.winners).toBe(2);
    const item = await itemRow(placed.itemIds[0]!);
    expect(item.shippedQuantity).toBe(4);
    expect((await orderRow(placed.orderId)).status).toBe('shipped');
    expect(await harness.ctx.db.select().from(shipments)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// FULFILL-003 — 确认收货 against the auto-receive job
// ---------------------------------------------------------------------------

describe('the buyer confirming while the auto-receive job fires', () => {
  async function shipped(): Promise<Placed> {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();
    await order.adminShip(asAdmin(adminId), { id: String(placed.orderId) }, shipBody(company));
    harness.queue.reset();
    return placed;
  }

  it('receives the order once and writes one timeline entry', async () => {
    const placed = await shipped();

    const report = await runConcurrently<Attempt>(
      2,
      (index) =>
        index === 0
          ? attempt(() =>
              order.confirmReceipt(racerUser(placed.userId), { id: String(placed.orderId) }),
            )
          : order
              .autoReceive(racerSystem(), { orderId: placed.orderId })
              .then((outcome) => ({ won: outcome.received })),
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);

    const logs = await harness.ctx.db
      .select()
      .from(orderStatusLogs)
      .where(eq(orderStatusLogs.orderId, placed.orderId));
    const receipts = logs.filter(
      (log) => log.changeType === 'received' || log.changeType === 'auto_received',
    );
    expect(receipts).toHaveLength(1);

    const row = await orderRow(placed.orderId);
    expect(row.status).toBe('received');
    expect(row.autoReceiveAt).toBeNull();
  });

  it('holds when six callers all confirm at the same instant', async () => {
    const placed = await shipped();

    const report = await runConcurrently<Attempt>(
      6,
      () =>
        order
          .autoReceive(racerSystem(), { orderId: placed.orderId })
          .then((outcome) => ({ won: outcome.received })),
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);
    expect(report.losers).toBe(5);
    // And exactly one completion job was scheduled, because only the winner
    // enqueues one.
    expect(harness.queue.jobs.filter((job) => job.jobName === 'order.complete')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// FULFILL-002 — a dispatch racing a refund approval
// ---------------------------------------------------------------------------

describe('shipping while a refund is approved for the same line', () => {
  it('never lets shipped + refunded exceed what was ordered', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    // Two units. One dispatch of two, one refund of two: they cannot both win.
    const placed = await paidOrder([{ ...product, quantity: 2 }]);
    const adminId = await makeAdmin();

    const report = await runConcurrently<Attempt>(
      2,
      (index) =>
        index === 0
          ? attempt(() =>
              order.adminShip(
                racerAdmin(adminId),
                { id: String(placed.orderId) },
                shipBody(company, [{ orderItemId: String(placed.itemIds[0]), quantity: 2 }]),
              ),
            )
          : approveRefund(racerSystem(), { orderItemId: placed.itemIds[0]!, quantity: 2 }).then(
              (result) => ({ won: result.won }),
            ),
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);

    const item = await itemRow(placed.itemIds[0]!);
    expect(item.shippedQuantity + item.refundedQuantity).toBeLessThanOrEqual(item.quantity);

    if (item.shippedQuantity === 2) {
      // The dispatch won: the refund found no units left to take.
      expect(item.refundedQuantity).toBe(0);
      expect((await orderRow(placed.orderId)).status).toBe('shipped');
    } else {
      // The refund won: nothing was sent, and the shipment rolled back with it.
      expect(item.refundedQuantity).toBe(2);
      expect(await harness.ctx.db.select().from(shipments)).toHaveLength(0);
      expect((await orderRow(placed.orderId)).status).toBe('paid');
    }
  });

  it('lets both through when there is room for both, and the roll-up still says fulfilled', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([{ ...product, quantity: 2 }]);
    const adminId = await makeAdmin();

    const report = await runConcurrently<Attempt>(
      2,
      (index) =>
        index === 0
          ? attempt(() =>
              order.adminShip(
                racerAdmin(adminId),
                { id: String(placed.orderId) },
                shipBody(company, [{ orderItemId: String(placed.itemIds[0]), quantity: 1 }]),
              ),
            )
          : approveRefund(racerSystem(), { orderItemId: placed.itemIds[0]!, quantity: 1 }).then(
              (result) => ({ won: result.won }),
            ),
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(2);
    const item = await itemRow(placed.itemIds[0]!);
    expect(item.shippedQuantity).toBe(1);
    expect(item.refundedQuantity).toBe(1);

    // One unit sent, one refunded: nothing is outstanding, so the order is done
    // rather than stuck in 部分发货.
    const row = await orderRow(placed.orderId);
    if (row.status === 'shipped') {
      expect(row.fulfillmentStatus).toBe('fulfilled');
    } else {
      // The refund committed after the roll-up was computed; 一键发货 finishes it.
      await order.adminShip(asAdmin(adminId), { id: String(placed.orderId) }, shipBody(company));
      expect((await orderRow(placed.orderId)).fulfillmentStatus).toBe('fulfilled');
    }
  });
});

// ---------------------------------------------------------------------------
// VIRTUAL-001 — the card key under a replayed paid effect
// ---------------------------------------------------------------------------

describe('two dispatchers replaying the same virtual delivery', () => {
  it('claims one card, writes one shipment and grants the coupons once', async () => {
    const card = await makeProduct('virtual_card');
    await makeCards(card, 5);
    const placed = await paidOrder([card]);

    const report = await runConcurrently<Attempt>(
      4,
      () => attempt(() => autoDeliver(racerSystem(), placed.orderId)),
      { isWinner: (outcome) => outcome.won },
    );

    // All four return without throwing; the idempotence gate makes three of
    // them no-ops rather than errors.
    expect(report.rejected).toHaveLength(0);
    expect(report.winners).toBe(4);

    expect(await harness.ctx.db.select().from(shipments)).toHaveLength(1);
    const claimed = await harness.ctx.db
      .select()
      .from(productVirtualCards)
      .where(eq(productVirtualCards.state, 'claimed'));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.orderItemId).toBe(placed.itemIds[0]);

    const logs = await harness.ctx.db
      .select()
      .from(orderStatusLogs)
      .where(
        and(
          eq(orderStatusLogs.orderId, placed.orderId),
          eq(orderStatusLogs.changeType, 'virtual_delivered'),
        ),
      );
    expect(logs).toHaveLength(1);
    expect((await orderRow(placed.orderId)).status).toBe('shipped');
  });

  it('gives the last card to exactly one of two orders racing for it', async () => {
    const card = await makeProduct('virtual_card');
    await makeCards(card, 1);
    const first = await paidOrder([card]);
    const second = await paidOrder([card]);

    // The first delivery stops just before it commits, still holding the card
    // it claimed, and stays there until the second has finished (or a second
    // has passed). A barrier start alone lets one run finish before the other
    // claims, and then a claim without `FOR UPDATE SKIP LOCKED` passes too
    // (MUT-001 `virtual-card-claim`): the second must reach the card while the
    // first still holds it. With the skip it finds no free card at once; without
    // it, it waits for the first to commit and then takes the same card again.
    let holding!: () => void;
    const firstHolds = new Promise<void>((resolve) => {
      holding = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    onShipmentDispatched.register('test: hold the first claim open', async (_tx, _ctx, event) => {
      if (event.orderId !== first.orderId) return;
      holding();
      await Promise.race([released, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    });

    const firstRun = attempt(() => autoDeliver(racerSystem(), first.orderId));
    await firstHolds;
    const secondOutcome = await autoDeliver(racerSystem(), second.orderId)
      .then(
        () => ({ delivered: true, error: null as unknown }),
        (error: unknown) => ({ delivered: false, error }),
      )
      .finally(release);
    const firstOutcome = await firstRun;

    // One delivers; the other throws, which is what hands its effect row back
    // to the ledger to retry and eventually park for a human.
    expect(firstOutcome).toEqual({ won: true });
    expect(secondOutcome.delivered).toBe(false);
    expect(String(secondOutcome.error)).toMatch(/卡密库存不足/);

    expect(await harness.ctx.db.select().from(shipments)).toHaveLength(1);
    const claimed = await harness.ctx.db
      .select()
      .from(productVirtualCards)
      .where(eq(productVirtualCards.state, 'claimed'));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.orderItemId).toBe(first.itemIds[0]);
  });
});

// ---------------------------------------------------------------------------
// the console's own conditional writes
// ---------------------------------------------------------------------------

describe('the console under concurrency', () => {
  it('lets 修改地址 lose to a dispatch that commits first', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();

    const report = await runConcurrently<Attempt>(
      2,
      (index) =>
        index === 0
          ? attempt(() =>
              order.adminShip(
                racerAdmin(adminId),
                { id: String(placed.orderId) },
                shipBody(company),
              ),
            )
          : attempt(() =>
              order.orderConsole.adminUpdateAddress(
                racerAdmin(adminId),
                { id: String(placed.orderId) },
                {
                  name: '李四',
                  phone: '13900139000',
                  province: '江苏省',
                  city: '南京市',
                  detail: '中山北路 1 号',
                },
              ),
            ),
      { isWinner: (outcome) => outcome.won },
    );

    const row = await orderRow(placed.orderId);
    if (row.fulfillmentStatus === 'fulfilled' && row.receiverName === '张三') {
      // The dispatch won: the label still matches the order.
      expect(report.winners).toBe(1);
    } else {
      // The address change won: it committed while nothing had gone out.
      expect(row.receiverName).toBe('李四');
    }
  });

  it('files an order away exactly once however many operators tick it', async () => {
    // A real cancellation, because `orders_paid_shape` will not let a test
    // fake one on top of a paid order.
    const product = await makeProduct();
    const userId = await makeUser();
    await harness.ctx.db.insert(cartItems).values({
      userId,
      productId: product.productId,
      skuId: product.skuId,
      quantity: 1,
      isSelected: true,
    });
    const detail = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      idempotencyKey: key(),
    });
    const placed = { orderId: Number(detail.id) };
    await order.cancel(as(userId), { id: detail.id }, {});
    const adminId = await makeAdmin();

    const report = await runConcurrently<Attempt>(
      4,
      () =>
        attempt(() =>
          order.orderConsole.adminDelete(racerAdmin(adminId), { id: String(placed.orderId) }),
        ),
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);
    expect(report.fulfilled.filter((o) => !o.won).map((o) => o.code)).toEqual([
      'ORDER_NOT_DELETABLE',
      'ORDER_NOT_DELETABLE',
      'ORDER_NOT_DELETABLE',
    ]);
    const logs = await harness.ctx.db
      .select()
      .from(orderStatusLogs)
      .where(
        and(
          eq(orderStatusLogs.orderId, placed.orderId),
          eq(orderStatusLogs.changeType, 'deleted_by_admin'),
        ),
      );
    expect(logs).toHaveLength(1);
  });
});
