import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { admins } from '@shop/db/schema/auth';
import { products, productSkus } from '@shop/db/schema/catalog';
import { orderItems, orders, type OrderItemSnapshot } from '@shop/db/schema/order';
import { capitalFlows } from '@shop/db/schema/payment';
import { refundItems, refunds } from '@shop/db/schema/refund';
import { effects } from '@shop/db/schema/system';
import { users } from '@shop/db/schema/user';
import {
  createTestCtx,
  flushTestRedis,
  forkTestCtx,
  runConcurrently,
  startFakeWechatGateway,
  type FakeWechatGateway,
  type TestCtx,
} from '@shop/testing';
import { resetEffectHandlers } from '../effects';
import { Money } from '../kernel/money';
import type { Actor, Ctx } from '../kernel/context';
import { installFulfilmentHooks } from '../order';
import { registerStockPort, resetOrderPorts, type StockLine } from '../order/ports';
import { handleTransactionNotify, paymentConfig, startPayment } from '../payment';
import { wechatConfig } from '../wechat';
import * as admin from './refund.admin';
import * as service from './refund.service';
import { refundSystemInitiated } from './refund.system.service';

/**
 * The refund nobody asked for.
 *
 * A failed group buy and an expired presale both owe a shopper their money
 * back, and there is no buyer to apply and no operator to approve. What must
 * still hold is everything the buyer's road holds: the service decides the
 * amount, the cumulative ceiling caps it, shipped goods are left to a person,
 * the gateway is called after commit, and running it twice refunds once.
 *
 * `groupbuy.int.test.ts` proves the join from the other side (the sweep's
 * effect reaches this function); this file proves the arithmetic.
 */

let harness: TestCtx;
let gateway: FakeWechatGateway;

const NOW = '2026-06-01T00:00:00.000Z';
const GROUPBUY_REASON = '拼团未成团，系统自动退款';
const PRESALE_REASON = '预售未成行，系统自动退款';

let releases: Array<{ orderId: number; lines: StockLine[] }> = [];

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
  gateway = await startFakeWechatGateway({ now: () => harness.clock.now().getTime() });
}, 180_000);

afterAll(async () => {
  await gateway?.close();
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
  resetEffectHandlers();
  resetOrderPorts();
  installFulfilmentHooks();
  releases = [];
  registerStockPort({
    async reserve() {
      return [];
    },
    async commit() {},
    async release(_tx, orderId, lines) {
      releases.push({ orderId, lines: [...lines] });
    },
  });
  gateway.transactions.clear();
  gateway.refunds.clear();
  gateway.calls.length = 0;
  gateway.behaviour.refundBalanceFen = null;
  gateway.behaviour.refundStatus = 'PROCESSING';
  gateway.behaviour.failNext = null;
  gateway.behaviour.dropNext = false;

  await harness.ctx.config.set(paymentConfig, {
    mchId: gateway.keys.mchId,
    apiV3Key: gateway.keys.apiV3Key,
    certSerial: gateway.keys.merchantSerial,
    merchantPrivateKey: gateway.keys.merchantPrivateKeyPem,
    platformPublicKeyId: gateway.keys.platformSerial,
    platformPublicKey: gateway.keys.platformPublicKeyPem,
    notifyBaseUrl: 'https://shop.example.test',
    apiBaseUrl: gateway.url,
    payExpiryMinutes: 30,
  });
  await harness.ctx.config.set(wechatConfig, {
    miniAppId: gateway.keys.appId,
    oaAppId: gateway.keys.appId,
  });
});

afterEach(() => {
  resetEffectHandlers();
  resetOrderPorts();
  installFulfilmentHooks();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const adminActor = (id: number): Actor => ({ kind: 'admin', id, permissions: [], isSuper: true });

function racer(actor?: Actor): Ctx {
  return forkTestCtx(harness, actor === undefined ? {} : { actor });
}

let sequence = 0;

const snapshot = (index: number): OrderItemSnapshot => ({
  productName: `团购商品 ${index + 1}`,
  productImageUrl: 'https://cdn.example.test/p.jpg',
  productKind: 'physical',
  skuCode: `SKU-${index + 1}`,
  specText: '默认',
  specValues: {},
});

interface Fixture {
  orderId: number;
  userId: number;
  adminId: number;
  itemIds: number[];
}

/**
 * A two-line group-buy order that reached `paid`.
 *
 * Two lines rather than one because most of what this function decides is
 * *per line* — a shipped one is skipped, an already-refunded one is skipped,
 * and the cap is spread over what is left.
 *
 * `paid` below the lines' total is the ordinary coupon shape: the order
 * collected 80.00 for 100.00 of goods, and the ceiling is what it collected.
 */
async function paidOrder(
  options: { paid?: string; freight?: string; shippedFirstLine?: boolean } = {},
): Promise<Fixture> {
  sequence += 1;
  const n = sequence;
  const db = harness.ctx.db;
  const freight = options.freight ?? '0.00';
  const itemsAmount = '100.00';
  const payable = options.paid ?? '100.00';

  const [user] = await db
    .insert(users)
    .values({ account: `sys-user-${n}` })
    .returning({ id: users.id });
  const [operator] = await db
    .insert(admins)
    .values({
      account: `sys-admin-${n}`,
      passwordHash: 'x'.repeat(60),
      name: `运营${n}`,
      isSuper: true,
    })
    .returning({ id: admins.id });
  const [product] = await db
    .insert(products)
    .values({
      name: `团购商品 ${n}`,
      imageUrl: 'https://cdn.example.test/p.jpg',
      status: 'on_shelf',
      freightMode: 'free',
      price: '50.00',
    })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(productSkus)
    .values({ productId: product!.id, skuCode: `SSKU${n}`, price: '50.00', stock: 100 })
    .returning({ id: productSkus.id });
  const [order] = await db
    .insert(orders)
    .values({
      orderNo: `SO${String(n).padStart(10, '0')}`,
      userId: user!.id,
      platform: 'wechat_mini',
      kind: 'groupbuy',
      status: 'pending_payment',
      totalQuantity: 2,
      itemsAmount,
      freightAmount: freight,
      payableAmount: payable,
      payExpiresAt: new Date(Date.parse(NOW) + 30 * 60_000),
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '广东省',
      receiverCity: '深圳市',
      receiverDetail: '某路 1 号',
    })
    .returning({ id: orders.id });

  const itemIds: number[] = [];
  for (const index of [0, 1]) {
    const [item] = await db
      .insert(orderItems)
      .values({
        orderId: order!.id,
        productId: product!.id,
        skuId: sku!.id,
        itemKey: `L${index + 1}`,
        quantity: 1,
        unitPrice: '50.00',
        totalAmount: '50.00',
        snapshot: snapshot(index),
      })
      .returning({ id: orderItems.id });
    itemIds.push(item!.id);
  }

  if (Money.parse(payable).isZero()) {
    // A coupon paid for all of it: settled without a payment attempt, the way
    // `settleZeroAmountOrder` marks it (REFUND-016).
    await db
      .update(orders)
      .set({ status: 'paid', paidAt: harness.clock.now(), paidAmount: '0.00' })
      .where(eq(orders.id, order!.id));
  } else {
    const intent = await startPayment(racer(userActor(user!.id)), {
      orderId: order!.id,
      channel: 'wechat_mini',
      openid: 'oFakeOpenid',
    });
    gateway.markPaid(intent.outTradeNo);
    const ack = await handleTransactionNotify(
      racer(),
      gateway.signTransactionNotification({ outTradeNo: intent.outTradeNo }),
    );
    expect(ack.status).toBe(200);
  }

  if (options.shippedFirstLine === true) {
    // One parcel is already moving. Its units are the warehouse's business and
    // the freight has been spent.
    await db.update(orderItems).set({ shippedQuantity: 1 }).where(eq(orderItems.id, itemIds[0]!));
    await db
      .update(orders)
      .set({ fulfillmentStatus: 'partially_fulfilled' })
      .where(eq(orders.id, order!.id));
  }

  return { orderId: order!.id, userId: user!.id, adminId: operator!.id, itemIds };
}

const systemRefund = (
  fixture: Fixture,
  reason: 'groupbuy_failed' | 'presale_expired' = 'groupbuy_failed',
  note?: string,
) =>
  harness.ctx.withTx((tx) =>
    refundSystemInitiated(tx, harness.ctx, {
      orderId: fixture.orderId,
      reason,
      ...(note === undefined ? {} : { note }),
    }),
  );

const refundRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(refunds)
    .where(eq(refunds.id, id))
    .then((rows) => rows[0]!);

const refundRows = (orderId: number) =>
  harness.ctx.db.select().from(refunds).where(eq(refunds.orderId, orderId));

const lineRows = (refundId: number) =>
  harness.ctx.db.select().from(refundItems).where(eq(refundItems.refundId, refundId));

const orderRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .then((rows) => rows[0]!);

const itemRows = (orderId: number) =>
  harness.ctx.db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.id);

const executeEffects = (refundId: number) =>
  harness.ctx.db
    .select()
    .from(effects)
    .where(eq(effects.scopeId, String(refundId)))
    .then((rows) => rows.filter((row) => row.eventType === 'refund.execute'));

// ---------------------------------------------------------------------------

describe('a refund the shop opens by itself', () => {
  it('takes every unshipped line, needs no approval, and queues the gateway call', async () => {
    const fixture = await paidOrder();

    const result = await systemRefund(fixture, 'groupbuy_failed', '拼团 9 未成团');
    expect(result.created).toBe(true);

    const row = await refundRow(result.refundId);
    expect(row).toMatchObject({
      status: 'approved',
      kind: 'refund_only',
      returnStage: 'not_required',
      isAutomatic: true,
      reason: GROUPBUY_REASON,
      // The note names internal ids: staff remark, not the shopper's
      // explanation (REFUND-019).
      explanation: null,
      adminRemark: '拼团 9 未成团',
      quantity: 2,
      amount: '100.00',
      includesFreight: false,
      // Nobody decided this, so nobody is recorded as having decided it.
      reviewedByAdminId: null,
    });
    expect(row.reviewedAt).not.toBeNull();

    const lines = await lineRows(result.refundId);
    expect(lines.map((line) => line.amount)).toEqual(['50.00', '50.00']);
    expect(lines.every((line) => line.isOpen)).toBe(true);

    // The units are out of the warehouse's reach from now on, exactly as an
    // approved 仅退款 puts them.
    expect((await itemRows(fixture.orderId)).map((item) => item.refundedQuantity)).toEqual([1, 1]);
    expect((await orderRow(fixture.orderId)).refundStatus).toBe('requested');

    // And the money has not moved yet: that is the effect's job, post-commit.
    expect(await executeEffects(result.refundId)).toHaveLength(1);
    expect(gateway.refunds.size).toBe(0);
  });

  it('answers the second caller with the first refund instead of opening another', async () => {
    const fixture = await paidOrder();
    const first = await systemRefund(fixture);
    const second = await systemRefund(fixture);

    expect(second).toEqual({ refundId: first.refundId, created: false });
    expect(await refundRows(fixture.orderId)).toHaveLength(1);
    expect(await executeEffects(first.refundId)).toHaveLength(1);
  });

  it('opens one refund when two callers arrive at the same instant', async () => {
    const fixture = await paidOrder();

    const report = await runConcurrently(6, () =>
      racer().withTx((tx) =>
        refundSystemInitiated(tx, racer(), { orderId: fixture.orderId, reason: 'groupbuy_failed' }),
      ),
    );

    // Whoever reaches the order's row lock first opens it; the rest either wait
    // and read it back, or lose the `refund_items_open_uq` race outright. What
    // may never happen is two refunds.
    const rows = await refundRows(fixture.orderId);
    expect(rows).toHaveLength(1);
    expect(report.fulfilled.filter((value) => value.created)).toHaveLength(1);
    for (const value of report.fulfilled) expect(value.refundId).toBe(rows[0]!.id);
  });

  it('gives the freight back only while nothing has shipped', async () => {
    const withFreight = await paidOrder({ paid: '108.00', freight: '8.00' });
    const whole = await systemRefund(withFreight);
    expect(await refundRow(whole.refundId)).toMatchObject({
      amount: '108.00',
      includesFreight: true,
    });

    // A parcel already moving means the carrier has been paid, and the unit
    // inside it is a person's decision, not this function's.
    const partly = await paidOrder({ paid: '108.00', freight: '8.00', shippedFirstLine: true });
    const rest = await systemRefund(partly);
    const row = await refundRow(rest.refundId);
    expect(row).toMatchObject({ amount: '50.00', quantity: 1, includesFreight: false });
    expect(await lineRows(rest.refundId)).toHaveLength(1);
    expect((await itemRows(partly.orderId)).map((item) => item.refundedQuantity)).toEqual([0, 1]);
  });

  it('never gives back more than the order collected', async () => {
    // 100.00 of goods, 80.00 actually paid — a coupon, a 拼团 price change, or
    // a partial refund somebody already made by hand.
    const fixture = await paidOrder({ paid: '80.00' });
    const result = await systemRefund(fixture);

    const row = await refundRow(result.refundId);
    expect(row.amount).toBe('80.00');
    // The cap is spread over the lines, so the refund and its items still add
    // up to the same number — the settlement raises each line by its own row.
    const lines = await lineRows(result.refundId);
    expect(lines.map((line) => line.amount)).toEqual(['50.00', '30.00']);
  });

  it('stands aside when the buyer already has a request on the line', async () => {
    const fixture = await paidOrder();
    await service.apply(racer(userActor(fixture.userId)), {
      orderId: String(fixture.orderId),
      kind: 'refund_only',
      lines: [{ orderItemId: String(fixture.itemIds[0]!), quantity: 1 }],
      reason: '不想要了',
      images: [],
      includeFreight: false,
    });

    await expect(systemRefund(fixture)).rejects.toMatchObject({ code: 'REFUND_ALREADY_OPEN' });
    expect(await refundRows(fixture.orderId)).toHaveLength(1);
  });

  it('refuses an order that never collected anything', async () => {
    const fixture = await paidOrder();
    await harness.ctx.db
      .update(orders)
      .set({ status: 'pending_payment', paidAmount: null, paidAt: null })
      .where(eq(orders.id, fixture.orderId));

    await expect(systemRefund(fixture)).rejects.toMatchObject({
      code: 'REFUND_ORDER_NOT_REFUNDABLE',
    });
  });

  it('refuses when there is nothing left to give back', async () => {
    const fixture = await paidOrder();
    const first = await systemRefund(fixture, 'groupbuy_failed');
    expect(first.created).toBe(true);

    // A presale expiry landing on an order a failed team already refunded: the
    // reason differs, so idempotency does not catch it — the lines do.
    await expect(systemRefund(fixture, 'presale_expired')).rejects.toMatchObject({
      code: 'REFUND_AMOUNT_ZERO',
    });
    expect((await refundRows(fixture.orderId)).map((row) => row.reason)).toEqual([GROUPBUY_REASON]);
  });

  it('settles through the same path an approved request does', async () => {
    const fixture = await paidOrder();
    const result = await systemRefund(fixture);

    gateway.behaviour.refundStatus = 'SUCCESS';
    expect(await service.executeRefund(racer(), result.refundId)).toEqual({
      status: 'succeeded',
      message: '退款成功',
    });

    const row = await refundRow(result.refundId);
    expect(row.status).toBe('succeeded');
    expect(row.succeededAt).not.toBeNull();

    const after = await orderRow(fixture.orderId);
    expect(after.refundedAmount).toBe('100.00');
    expect(after.refundStatus).toBe('refunded');
    expect(after.status).toBe('refunded');

    // The ledger and the warehouse hear about it exactly once, through
    // `onOrderRefunded`, like any other refund.
    const flows = await harness.ctx.db
      .select()
      .from(capitalFlows)
      .where(eq(capitalFlows.kind, 'order_refund'));
    expect(flows).toHaveLength(1);
    expect(flows[0]!.amount).toBe('100.00');
    expect(releases).toHaveLength(1);
    expect(releases[0]!.lines).toHaveLength(2);
  });

  it('is visible to the buyer and the operator as an ordinary refund', async () => {
    const fixture = await paidOrder();
    const result = await systemRefund(fixture);

    const mine = await service.myList(racer(userActor(fixture.userId)), {
      state: 'open',
      page: 1,
      pageSize: 20,
    });
    expect(mine.items.map((item) => item.id)).toEqual([String(result.refundId)]);

    const seen = await admin.adminDetail(racer(adminActor(fixture.adminId)), {
      id: String(result.refundId),
    });
    expect(seen.reason).toBe(GROUPBUY_REASON);
    expect(seen.logs.at(-1)?.message).toContain(GROUPBUY_REASON);
  });

  it('writes the presale reason for a presale', async () => {
    const fixture = await paidOrder();
    const result = await systemRefund(fixture, 'presale_expired');
    expect((await refundRow(result.refundId)).reason).toBe(PRESALE_REASON);
  });
});

// ---------------------------------------------------------------------------
// REFUND-016 — an order a coupon paid for in full
// ---------------------------------------------------------------------------

describe('REFUND-016 — an order a coupon paid for in full has a way out', () => {
  it('REFUND-016 — a failed group buy on a ¥0 order settles without the gateway and releases stock', async () => {
    const fixture = await paidOrder({ paid: '0.00' });

    const result = await systemRefund(fixture);
    expect(result.created).toBe(true);
    expect(await refundRow(result.refundId)).toMatchObject({
      status: 'approved',
      amount: '0.00',
      includesFreight: false,
      quantity: 2,
    });

    expect(await service.executeRefund(racer(), result.refundId)).toEqual({
      status: 'succeeded',
      message: '已退款',
    });

    expect((await refundRow(result.refundId)).status).toBe('succeeded');
    // Nothing moved, so nothing is booked and WeChat never heard of it.
    expect(await harness.ctx.db.select().from(capitalFlows)).toEqual([]);
    expect(gateway.refunds.size).toBe(0);
    // The goods and the order come back all the same.
    expect(releases).toHaveLength(1);
    const after = await orderRow(fixture.orderId);
    expect(after.refundStatus).toBe('refunded');
    expect(after.status).toBe('refunded');
    expect(after.refundedAmount).toBe('0.00');
    expect((await itemRows(fixture.orderId)).map((item) => item.refundedQuantity)).toEqual([1, 1]);
  });

  it('REFUND-016 — a shopper can ask for a ¥0 order back, and the approval settles it', async () => {
    const fixture = await paidOrder({ paid: '0.00' });
    const applied = await service.apply(racer(userActor(fixture.userId)), {
      orderId: String(fixture.orderId),
      kind: 'refund_only',
      lines: fixture.itemIds.map((id) => ({ orderItemId: String(id), quantity: 1 })),
      reason: '不想要了',
      images: [],
      includeFreight: true,
    });
    expect(applied).toMatchObject({ amount: '0.00', includesFreight: false });

    await admin.adminApprove(racer(adminActor(fixture.adminId)), { id: applied.id });
    await service.executeRefund(racer(), Number(applied.id));

    expect((await refundRow(Number(applied.id))).status).toBe('succeeded');
    expect((await orderRow(fixture.orderId)).status).toBe('refunded');
    expect(releases).toHaveLength(1);

    const seen = await service.myDetail(racer(userActor(fixture.userId)), { id: applied.id });
    expect(seen.logs.at(-1)?.message).toBe('售后已完成');
  });
});

// ---------------------------------------------------------------------------
// REFUND-018 — the freight on a second request
// ---------------------------------------------------------------------------

describe('REFUND-018 — the freight goes with the rest of an unshipped order', () => {
  const ask = (fixture: Fixture, index: number, includeFreight: boolean) =>
    service.apply(racer(userActor(fixture.userId)), {
      orderId: String(fixture.orderId),
      kind: 'refund_only',
      lines: [{ orderItemId: String(fixture.itemIds[index]!), quantity: 1 }],
      reason: '不想要了',
      images: [],
      includeFreight,
    });

  it('REFUND-018 — gives the freight back with the second request while the first holds the other line', async () => {
    const fixture = await paidOrder({ freight: '8.00', paid: '108.00' });
    await ask(fixture, 0, false);

    // What the apply screen reads, and decides `includesFreight` from.
    const offered = await service.applicableItems(racer(userActor(fixture.userId)), {
      orderId: String(fixture.orderId),
    });
    expect(offered.freightRefundable).toBe(true);

    const second = await ask(fixture, 1, true);
    expect(second).toMatchObject({ amount: '58.00', includesFreight: true });

    // And only once.
    const after = await service.applicableItems(racer(userActor(fixture.userId)), {
      orderId: String(fixture.orderId),
    });
    expect(after.freightRefundable).toBe(false);
  });

  it('REFUND-018 — refuses the freight on a request that leaves a takeable line behind', async () => {
    const fixture = await paidOrder({ freight: '8.00', paid: '108.00' });
    await expect(ask(fixture, 1, true)).rejects.toMatchObject({
      code: 'REFUND_FREIGHT_NOT_REFUNDABLE',
      details: { reason: 'partial-refund' },
    });
  });
});
