import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { admins } from '@shop/db/schema/auth';
import { products, productSkus } from '@shop/db/schema/catalog';
import { orderItems, orders, type OrderItemSnapshot } from '@shop/db/schema/order';
import { capitalFlows, paymentCallbacks } from '@shop/db/schema/payment';
import { expressCompanies } from '@shop/db/schema/reference';
import { refundItems, refunds } from '@shop/db/schema/refund';
import { effects as effectsTable } from '@shop/db/schema/system';
import { users } from '@shop/db/schema/user';
import {
  createTestCtx,
  flushTestRedis,
  forkTestCtx,
  runConcurrently,
  startFakeWechatGateway,
  type FakeWechatGateway,
  type SignedNotification,
  type TestCtx,
} from '@shop/testing';
import { drainEffects, resetEffectHandlers } from '../effects';
import type { Actor, Ctx } from '../kernel/context';
import {
  registerStockPort,
  resetOrderPorts,
  type StockLine,
  type StockReleaseOptions,
} from '../order/ports';
import { installFulfilmentHooks, shipOrder } from '../order';
import { handleTransactionNotify, paymentConfig, startPayment } from '../payment';
import { wechatConfig } from '../wechat';
import { refundConfig } from './refund.config';
import { registerRefundEffects } from './refund.effects';
import * as repo from './refund.repo';
import * as admin from './refund.admin';
import * as service from './refund.service';

/**
 * The after-sales races.
 *
 * Three mandatory scenarios live here — two simultaneous refund requests on one
 * order line, an approval racing the buyer's withdrawal, and a duplicate refund
 * callback — plus the reconciliation sweep racing a refund notification and a
 * statement-level race for every conditional update they depend on.
 *
 * Everything starts from a *genuinely* paid order: the fixture runs the real
 * payment flow against the fake gateway, so the attempt the refund is frozen
 * against is a real `payment_attempts` row with a real transaction id, and the
 * refund really goes back through `/v3/refund/domestic/refunds`.
 */

let harness: TestCtx;
let gateway: FakeWechatGateway;

const NOW = '2026-06-01T00:00:00.000Z';

/** Every `StockPort.release` the settlement made, in order. */
interface Release {
  orderId: number;
  lines: StockLine[];
  options: StockReleaseOptions | undefined;
}
let releases: Release[] = [];

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
  // `ConfigService.set` writes only the keys that *changed*, and after a
  // truncate the cache still holds the old ones — so without this the groups
  // end up empty and every gateway call answers 支付尚未配置.
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
    async release(_tx, orderId, lines, options) {
      releases.push({ orderId, lines: [...lines], options });
    },
  });
  gateway.transactions.clear();
  gateway.refunds.clear();
  gateway.calls.length = 0;
  gateway.behaviour.refundBalanceFen = null;
  gateway.behaviour.refundStatus = 'PROCESSING';
  gateway.behaviour.signResponsesWithWrongKey = false;
  gateway.behaviour.failNext = null;
  gateway.behaviour.dropNext = false;
  await configure();
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

async function configure(): Promise<void> {
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
}

let sequence = 0;

const snapshot = (index: number): OrderItemSnapshot => ({
  productName: `测试商品 ${index + 1}`,
  productImageUrl: 'https://cdn.example.test/p.jpg',
  productKind: 'physical',
  skuCode: `SKU-${index + 1}`,
  specText: '默认',
  specValues: {},
});

interface PaidOrder {
  orderId: number;
  userId: number;
  adminId: number;
  itemIds: number[];
  skuIds: number[];
  payable: string;
  outTradeNo: string;
}

interface Line {
  quantity: number;
  unitPrice: string;
  totalAmount: string;
}

/**
 * An order that was really paid: a gateway transaction, a verified
 * notification, a `paid` attempt and a `paid` order.
 */
async function paidOrder(
  lines: Line[] = [{ quantity: 2, unitPrice: '50.00', totalAmount: '100.00' }],
  options: { shippedQuantities?: number[] } = {},
): Promise<PaidOrder> {
  sequence += 1;
  const n = sequence;
  const db = harness.ctx.db;
  const payable = lines.reduce((sum, line) => sum + Number(line.totalAmount), 0).toFixed(2);

  const [user] = await db
    .insert(users)
    .values({ account: `refund-user-${n}` })
    .returning({ id: users.id });
  const [operator] = await db
    .insert(admins)
    .values({
      account: `refund-admin-${n}`,
      passwordHash: 'x'.repeat(60),
      name: `运营${n}`,
      isSuper: true,
    })
    .returning({ id: admins.id });
  const [product] = await db
    .insert(products)
    .values({
      name: `测试商品 ${n}`,
      imageUrl: 'https://cdn.example.test/p.jpg',
      status: 'on_shelf',
      freightMode: 'free',
      price: lines[0]!.unitPrice,
    })
    .returning({ id: products.id });
  const [order] = await db
    .insert(orders)
    .values({
      orderNo: `SO${String(n).padStart(10, '0')}`,
      userId: user!.id,
      platform: 'wechat_mini',
      status: 'pending_payment',
      totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
      itemsAmount: payable,
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
  const skuIds: number[] = [];
  for (const [index, line] of lines.entries()) {
    const [sku] = await db
      .insert(productSkus)
      .values({
        productId: product!.id,
        skuCode: `SKU${n}-${index}`,
        specText: `规格${index}`,
        price: line.unitPrice,
        stock: 100,
      })
      .returning({ id: productSkus.id });
    const [item] = await db
      .insert(orderItems)
      .values({
        orderId: order!.id,
        productId: product!.id,
        skuId: sku!.id,
        itemKey: `L${index + 1}`,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        totalAmount: line.totalAmount,
        shippedQuantity: options.shippedQuantities?.[index] ?? 0,
        snapshot: snapshot(index),
      })
      .returning({ id: orderItems.id });
    itemIds.push(item!.id);
    skuIds.push(sku!.id);
  }

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

  return {
    orderId: order!.id,
    userId: user!.id,
    adminId: operator!.id,
    itemIds,
    skuIds,
    payable,
    outTradeNo: intent.outTradeNo,
  };
}

function applyBody(
  order: PaidOrder,
  lines: Array<{ orderItemId: number; quantity: number }>,
): Parameters<typeof service.apply>[1] {
  return {
    orderId: String(order.orderId),
    kind: 'refund_only',
    lines: lines.map((line) => ({
      orderItemId: String(line.orderItemId),
      quantity: line.quantity,
    })),
    reason: '不想要了',
    images: [],
    includeFreight: false,
  };
}

/** Applies, approves and submits one refund, leaving it `processing` at the gateway. */
async function processingRefund(order: PaidOrder): Promise<{ id: number; outRefundNo: string }> {
  const applied = await service.apply(
    racer(userActor(order.userId)),
    applyBody(order, [{ orderItemId: order.itemIds[0]!, quantity: 1 }]),
  );
  const id = Number(applied.id);
  await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });
  const result = await service.executeRefund(racer(), id);
  expect(result.status).toBe('processing');
  const row = await repo.findRefund(harness.ctx.db, id);
  return { id, outRefundNo: row!.outRefundNo };
}

function refundNotify(signed: SignedNotification): Promise<{ status: number }> {
  return service.handleRefundNotify(racer(), signed);
}

// --- readers ---------------------------------------------------------------

const refundRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(refunds)
    .where(eq(refunds.id, id))
    .then((rows) => rows[0]!);

const orderRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .then((rows) => rows[0]!);

const refundRows = () => harness.ctx.db.select().from(refunds);
const refundItemRows = () => harness.ctx.db.select().from(refundItems);
const flowRows = (kind: 'order_payment' | 'order_refund') =>
  harness.ctx.db.select().from(capitalFlows).where(eq(capitalFlows.kind, kind));
const effectRows = (eventType: string) =>
  harness.ctx.db.select().from(effectsTable).where(eq(effectsTable.eventType, eventType));

// ---------------------------------------------------------------------------
// REFUND-001 — one line, two requests
// ---------------------------------------------------------------------------

describe('REFUND-001 — two refund requests on one order line', () => {
  it('lets exactly one request hold the line', async () => {
    const order = await paidOrder();

    const report = await runConcurrently(6, () =>
      service.apply(
        racer(userActor(order.userId)),
        applyBody(order, [{ orderItemId: order.itemIds[0]!, quantity: 1 }]),
      ),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(5);
    // The partial unique index decided it; the service only named the error.
    for (const error of report.rejected) {
      expect(error).toMatchObject({ name: 'DomainError', code: 'REFUND_ALREADY_OPEN' });
    }
    expect(await refundRows()).toHaveLength(1);
    expect(await refundItemRows()).toHaveLength(1);
    expect((await orderRow(order.orderId)).refundStatus).toBe('requested');
  });

  it('never lets two requests together ask for more than was paid', async () => {
    const order = await paidOrder([
      { quantity: 1, unitPrice: '60.00', totalAmount: '60.00' },
      { quantity: 1, unitPrice: '40.00', totalAmount: '40.00' },
    ]);

    // Two different lines, so the open-line index does not fire: the ceiling is
    // what has to hold, and it is read under the order's row lock.
    const report = await runConcurrently(2, (index) =>
      service.apply(
        racer(userActor(order.userId)),
        applyBody(order, [{ orderItemId: order.itemIds[index]!, quantity: 1 }]),
      ),
    );

    expect(report.rejected).toEqual([]);
    const open = await repo.openRefundTotal(harness.ctx.db, order.orderId);
    expect(Number(open)).toBeLessThanOrEqual(Number(order.payable));
    expect(Number(open)).toBe(100);
  });

  it('sums duplicate lines in one body instead of checking them twice', async () => {
    const order = await paidOrder([{ quantity: 1, unitPrice: '50.00', totalAmount: '50.00' }]);
    await expect(
      service.apply(
        racer(userActor(order.userId)),
        applyBody(order, [
          { orderItemId: order.itemIds[0]!, quantity: 1 },
          { orderItemId: order.itemIds[0]!, quantity: 1 },
        ]),
      ),
    ).rejects.toMatchObject({ name: 'DomainError', code: 'REFUND_LINE_INVALID' });
    expect(await refundRows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REFUND-002 — the operator approves while the buyer withdraws
// ---------------------------------------------------------------------------

describe('REFUND-002 — approval racing the buyer withdrawing', () => {
  it('never sends money for a request the buyer took back', async () => {
    const order = await paidOrder();
    const applied = await service.apply(
      racer(userActor(order.userId)),
      applyBody(order, [{ orderItemId: order.itemIds[0]!, quantity: 1 }]),
    );
    const id = Number(applied.id);
    gateway.behaviour.refundStatus = 'SUCCESS';

    // Both *may* succeed: withdrawing an approved-but-unexecuted request is
    // allowed, so `cancel` accepts `applied` and `approved` alike. What must
    // hold is not "one winner" but that the row ends somewhere legal and that
    // the queued gateway call refuses to run on a withdrawn request.
    const report = await runConcurrently<{ by: 'admin' | 'buyer' }>(2, async (index) => {
      if (index === 0) {
        await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });
        return { by: 'admin' };
      }
      await service.cancel(racer(userActor(order.userId)), { id: String(id) });
      return { by: 'buyer' };
    });

    for (const error of report.rejected) {
      expect(error).toMatchObject({ name: 'DomainError', code: 'REFUND_NOT_ACTIONABLE' });
    }

    const row = await refundRow(id);
    expect(['approved', 'cancelled']).toContain(row.status);
    expect(row.succeededAt).toBeNull();

    registerRefundEffects();
    await drainEffects(racer(), { batchSize: 5 });

    if (row.status === 'cancelled') {
      expect(row.cancelledAt).not.toBeNull();
      // The effect ran and found a request nobody may pay out.
      expect(gateway.refunds.size).toBe(0);
      expect((await refundRow(id)).status).toBe('cancelled');
      expect((await orderRow(order.orderId)).refundedAmount).toBe('0.00');
      expect(releases).toEqual([]);
      // REFUND-015: withdrawing after the approval hands the units back to the
      // warehouse; a withdrawn request no longer holds anything.
      const [line] = await harness.ctx.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.id, order.itemIds[0]!));
      expect(line!.refundedQuantity).toBe(0);
    } else {
      expect(gateway.refunds.size).toBe(1);
      expect((await refundRow(id)).status).toBe('succeeded');
    }
  });

  it('is the claim, not the review, that excludes a withdrawal once the money moves', async () => {
    const order = await paidOrder();
    const applied = await service.apply(
      racer(userActor(order.userId)),
      applyBody(order, [{ orderItemId: order.itemIds[0]!, quantity: 1 }]),
    );
    const id = Number(applied.id);
    gateway.behaviour.refundStatus = 'SUCCESS';
    await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });

    // `executeRefund` claims `approved → processing` in one conditional update,
    // and `cancel` needs `applied` or `approved`. Exactly one of them can win.
    const report = await runConcurrently<{ by: 'gateway' | 'buyer' }>(2, async (index) => {
      if (index === 0) {
        await service.executeRefund(racer(), id);
        return { by: 'gateway' };
      }
      await service.cancel(racer(userActor(order.userId)), { id: String(id) });
      return { by: 'buyer' };
    });

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]).toMatchObject({
      name: 'DomainError',
      code: 'REFUND_NOT_ACTIONABLE',
    });

    const row = await refundRow(id);
    if (row.status === 'cancelled') {
      // The buyer won: WeChat never heard of this refund.
      expect(gateway.refunds.size).toBe(0);
      expect((await orderRow(order.orderId)).refundedAmount).toBe('0.00');
      expect(releases).toEqual([]);
    } else {
      expect(row.status).toBe('succeeded');
      expect(gateway.refunds.size).toBe(1);
      expect((await orderRow(order.orderId)).refundedAmount).toBe('50.00');
      expect(releases).toHaveLength(1);
    }
  });

  it('moves `applied` exactly once — the conditional update alone', async () => {
    const order = await paidOrder();
    const applied = await service.apply(
      racer(userActor(order.userId)),
      applyBody(order, [{ orderItemId: order.itemIds[0]!, quantity: 1 }]),
    );
    const id = Number(applied.id);

    const report = await runConcurrently(
      8,
      () => {
        const ctx = racer();
        return ctx.withTx((tx) =>
          repo.transitionRefund(tx, id, ['applied'], 'approved', { reviewedAt: ctx.clock.now() }),
        );
      },
      // `{ affected: 0, won: false }` is truthy; without this the test proves
      // nothing at all.
      { isWinner: (result) => result.won },
    );

    expect(report.winners).toBe(1);
    expect(report.losers).toBe(7);
  });

  it('queues one gateway call however many times the operator presses 同意', async () => {
    const order = await paidOrder();
    const applied = await service.apply(
      racer(userActor(order.userId)),
      applyBody(order, [{ orderItemId: order.itemIds[0]!, quantity: 1 }]),
    );
    const id = Number(applied.id);

    const report = await runConcurrently(5, () =>
      admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) }),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(4);
    expect(await effectRows('refund.execute')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// REFUND-003 — the same refund notification, delivered many times
// ---------------------------------------------------------------------------

describe('REFUND-003 — duplicate refund callback', () => {
  it('gives the money back once however many times WeChat delivers it', async () => {
    const order = await paidOrder();
    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'SUCCESS');
    const signed = gateway.signRefundNotification({ outRefundNo: refund.outRefundNo });

    const report = await runConcurrently(6, () => refundNotify(signed), {
      isWinner: (result) => result.status === 200,
    });

    expect(report.winners).toBe(6);
    expect(report.rejected).toEqual([]);

    const row = await refundRow(refund.id);
    expect(row.status).toBe('succeeded');
    expect(row.succeededAt).not.toBeNull();
    expect(row.refundedAmount).toBe('50.00');

    const orderAfter = await orderRow(order.orderId);
    expect(orderAfter.refundedAmount).toBe('50.00');
    expect(orderAfter.refundStatus).toBe('partially_refunded');
    // A partial refund does not end the order.
    expect(orderAfter.status).toBe('paid');

    expect(await flowRows('order_refund')).toHaveLength(1);
    expect(await effectRows('order.refunded')).toHaveLength(1);
    // One payment callback plus one refund callback, and no duplicates of either.
    expect(await harness.ctx.db.select().from(paymentCallbacks)).toHaveLength(2);

    // The unshipped line went back on the shelf exactly once, keyed by refund.
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      orderId: order.orderId,
      lines: [{ skuId: order.skuIds[0], quantity: 1 }],
      options: { committed: true, refundId: refund.id },
    });
  });

  it('refuses a notification whose signature does not verify, before touching the database', async () => {
    const order = await paidOrder();
    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'SUCCESS');
    gateway.behaviour.signResponsesWithWrongKey = true;
    const forged = gateway.signRefundNotification({ outRefundNo: refund.outRefundNo });

    const result = await service.handleRefundNotify(racer(), forged);

    expect(result.status).toBe(401);
    // Nothing was recorded: the callback ledger still holds only the payment one.
    expect(await harness.ctx.db.select().from(paymentCallbacks)).toHaveLength(1);
    expect((await refundRow(refund.id)).status).toBe('processing');
    expect(await flowRows('order_refund')).toEqual([]);
  });

  it('closes a refund the gateway reports ABNORMAL without touching the order', async () => {
    const order = await paidOrder();
    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'ABNORMAL');
    const signed = gateway.signRefundNotification({
      outRefundNo: refund.outRefundNo,
      eventType: 'REFUND.ABNORMAL',
    });

    expect((await refundNotify(signed)).status).toBe(200);

    const row = await refundRow(refund.id);
    expect(row.status).toBe('failed');
    // Staff read what to do; WeChat's status stays under 技术详情.
    expect(row.lastError).toBe('notify: ABNORMAL');
    expect(row.lastErrorSummary).toBe(
      '退款异常：买家的银行卡可能已注销或冻结，请到微信支付商户平台手动处理',
    );
    expect((await orderRow(order.orderId)).refundedAmount).toBe('0.00');
    expect(await flowRows('order_refund')).toEqual([]);
    expect(releases).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REFUND-006 — the sweep racing the notification
// ---------------------------------------------------------------------------

describe('REFUND-006 — reconciliation racing a refund callback', () => {
  it('settles once when the query and the notification arrive together', async () => {
    const order = await paidOrder();
    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'SUCCESS');
    const signed = gateway.signRefundNotification({ outRefundNo: refund.outRefundNo });

    const report = await runConcurrently(4, (index) =>
      index % 2 === 0
        ? service.reconcileRefund(racer(), refund.id).then(() => 'query')
        : refundNotify(signed).then(() => 'notify'),
    );

    expect(report.rejected).toEqual([]);
    expect((await refundRow(refund.id)).status).toBe('succeeded');
    expect((await orderRow(order.orderId)).refundedAmount).toBe('50.00');
    expect(await flowRows('order_refund')).toHaveLength(1);
    expect(await effectRows('order.refunded')).toHaveLength(1);
    expect(releases).toHaveLength(1);
    // Never a second refund at the gateway: the frozen number is queried, not re-sent.
    expect(gateway.refunds.size).toBe(1);
  });

  it('sends one refund however many effect dispatchers run', async () => {
    const order = await paidOrder();
    const applied = await service.apply(
      racer(userActor(order.userId)),
      applyBody(order, [{ orderItemId: order.itemIds[0]!, quantity: 1 }]),
    );
    const id = Number(applied.id);
    gateway.behaviour.refundStatus = 'SUCCESS';
    await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });

    registerRefundEffects();
    const report = await runConcurrently(3, () => drainEffects(racer(), { batchSize: 5 }));

    expect(report.rejected).toEqual([]);
    // Every row the three dispatchers finished was finished by exactly one of
    // them. Settling records `order.refunded` (delivered to a logged no-op), so
    // the count is not simply 1: it is the rows now `done`.
    const done = await harness.ctx.db
      .select({ eventType: effectsTable.eventType })
      .from(effectsTable)
      .where(eq(effectsTable.status, 'done'));
    expect(report.fulfilled.reduce((sum, r) => sum + r.done, 0)).toBe(done.length);
    expect(done.filter((row) => row.eventType === 'refund.execute')).toHaveLength(1);
    expect(gateway.refunds.size).toBe(1);
    expect((await refundRow(id)).status).toBe('succeeded');
    expect(await flowRows('order_refund')).toHaveLength(1);
    expect(releases).toHaveLength(1);
  });

  it('ends the order and releases nothing twice when the last line is refunded', async () => {
    const order = await paidOrder([{ quantity: 1, unitPrice: '100.00', totalAmount: '100.00' }]);
    const applied = await service.apply(
      racer(userActor(order.userId)),
      applyBody(order, [{ orderItemId: order.itemIds[0]!, quantity: 1 }]),
    );
    const id = Number(applied.id);
    gateway.behaviour.refundStatus = 'SUCCESS';
    await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });
    await service.executeRefund(racer(), id);

    const after = await orderRow(order.orderId);
    expect(after.refundedAmount).toBe('100.00');
    expect(after.refundStatus).toBe('refunded');
    expect(after.status).toBe('refunded');
    expect(await flowRows('order_refund')).toHaveLength(1);

    // A settlement that arrives again changes nothing at all.
    gateway.markRefunded((await refundRow(id)).outRefundNo, 'SUCCESS');
    const signed = gateway.signRefundNotification({
      outRefundNo: (await refundRow(id)).outRefundNo,
    });
    expect((await refundNotify(signed)).status).toBe(200);
    expect((await orderRow(order.orderId)).refundedAmount).toBe('100.00');
    expect(await flowRows('order_refund')).toHaveLength(1);
    expect(releases).toHaveLength(1);
  });

  it('does not restock a line that has already shipped', async () => {
    await harness.ctx.config.set(refundConfig, {
      returnName: '售后部',
      returnPhone: '13800000000',
      returnAddress: '浙江省杭州市西湖区文一西路 1 号',
    });
    const order = await paidOrder([{ quantity: 1, unitPrice: '100.00', totalAmount: '100.00' }], {
      shippedQuantities: [1],
    });
    const applied = await service.apply(racer(userActor(order.userId)), {
      ...applyBody(order, [{ orderItemId: order.itemIds[0]!, quantity: 1 }]),
      kind: 'return_and_refund',
    });
    const id = Number(applied.id);
    gateway.behaviour.refundStatus = 'SUCCESS';
    await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });
    await admin.adminReceiveReturn(racer(adminActor(order.adminId)), { id: String(id) });
    await service.executeRefund(racer(), id);

    expect((await refundRow(id)).status).toBe('succeeded');
    // Goods that left the warehouse come back through the operator's inbound
    // step, not through the refund — an unchecked return must not become stock.
    expect(releases).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FULFILL-002 (the refund half) — the warehouse and the operator, on the same
// units
// ---------------------------------------------------------------------------

/**
 * Fulfilment's dispatch bound is `shipped + q <= quantity - refunded_quantity`;
 * the mirror, on this side, is `refunded <= quantity - shipped_quantity`. Both
 * are `WHERE` clauses, so the database decides and the two services never have
 * to agree on an order of operations.
 *
 * Both services are the real ones here. A test with a hand-written `UPDATE`
 * standing in for one of them proves the SQL, not the system: it cannot catch
 * an approval that forgets to take the units at all, which is exactly the bug
 * this pair of bounds exists to stop.
 */
describe('shipping the last unshipped units while a 仅退款 is approved', () => {
  async function expressCompany(): Promise<number> {
    sequence += 1;
    const [row] = await harness.ctx.db
      .insert(expressCompanies)
      .values({ code: `sf-${sequence}`, name: `顺丰${sequence}` })
      .returning({ id: expressCompanies.id });
    return row!.id;
  }

  type Outcome = { who: 'warehouse' | 'operator'; won: boolean };

  async function race(
    order: PaidOrder,
    refundId: number,
    shipFirst: boolean,
    shipQuantity = 1,
  ): Promise<Outcome[]> {
    const companyId = await expressCompany();
    const report = await runConcurrently<Outcome>(2, async (index) => {
      const shipping = shipFirst ? index === 0 : index === 1;
      try {
        if (shipping) {
          await shipOrder(racer(adminActor(order.adminId)), {
            orderId: order.orderId,
            operatorAdminId: order.adminId,
            body: {
              deliveryMode: 'express',
              expressCompanyId: String(companyId),
              trackingNo: `SF-${(sequence += 1).toString()}`,
              lines: [{ orderItemId: String(order.itemIds[0]!), quantity: shipQuantity }],
            },
          });
          return { who: 'warehouse', won: true };
        }
        await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(refundId) });
        return { who: 'operator', won: true };
      } catch {
        return { who: shipping ? 'warehouse' : 'operator', won: false };
      }
    });
    expect(report.rejected).toEqual([]);
    return report.fulfilled;
  }

  async function applied(order: PaidOrder, quantity = 1): Promise<number> {
    const refund = await service.apply(
      racer(userActor(order.userId)),
      applyBody(order, [{ orderItemId: order.itemIds[0]!, quantity }]),
    );
    return Number(refund.id);
  }

  const theLine = (order: PaidOrder) =>
    harness.ctx.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.id, order.itemIds[0]!))
      .then((rows) => rows[0]!);

  for (const shipFirst of [true, false]) {
    it(`has exactly one winner when ${shipFirst ? 'the warehouse' : 'the operator'} goes first`, async () => {
      const order = await paidOrder([{ quantity: 1, unitPrice: '100.00', totalAmount: '100.00' }]);
      const refundId = await applied(order);

      const outcomes = await race(order, refundId, shipFirst);
      expect(outcomes.filter((outcome) => outcome.won)).toHaveLength(1);

      const line = await theLine(order);
      // The invariant, stated plainly: a unit is shipped or refunded, never
      // both.
      expect(line.shippedQuantity + line.refundedQuantity).toBeLessThanOrEqual(line.quantity);

      const winner = outcomes.find((outcome) => outcome.won)!.who;
      if (winner === 'warehouse') {
        expect(line.shippedQuantity).toBe(1);
        expect(line.refundedQuantity).toBe(0);
        // The request is not dead — it is a return now, and it is still open
        // for the operator to handle as one.
        expect((await refundRow(refundId)).status).toBe('applied');
      } else {
        expect(line.shippedQuantity).toBe(0);
        // Approving a 仅退款 takes the units out of fulfilment immediately,
        // before the money moves: the warehouse must not ship them afterwards.
        expect(line.refundedQuantity).toBe(1);
        expect((await refundRow(refundId)).status).toBe('approved');
      }
    });
  }

  for (const shipFirst of [true, false]) {
    it(`REFUND-021 — has exactly one winner on a line shipped in part before the request, when ${shipFirst ? 'the warehouse' : 'the operator'} goes first`, async () => {
      // Three units, one sent earlier; the buyer asks for the other two as a
      // 仅退款 while the warehouse sends those same two.
      const order = await paidOrder([{ quantity: 3, unitPrice: '10.00', totalAmount: '30.00' }], {
        shippedQuantities: [1],
      });
      const refundId = await applied(order, 2);

      const outcomes = await race(order, refundId, shipFirst, 2);
      expect(outcomes.filter((outcome) => outcome.won)).toHaveLength(1);

      const line = await theLine(order);
      const winner = outcomes.find((outcome) => outcome.won)!.who;
      if (winner === 'warehouse') {
        expect(line.shippedQuantity).toBe(3);
        expect(line.refundedQuantity).toBe(0);
        expect((await refundRow(refundId)).status).toBe('applied');
      } else {
        expect(line.shippedQuantity).toBe(1);
        expect(line.refundedQuantity).toBe(2);
        expect((await refundRow(refundId)).status).toBe('approved');
      }
    });
  }

  it('REFUND-021 — refuses a 仅退款 whose units shipped after the buyer asked, and still approves one on goods shipped before', async () => {
    const companyId = await expressCompany();
    const ship = (order: PaidOrder, quantity: number) =>
      shipOrder(racer(adminActor(order.adminId)), {
        orderId: order.orderId,
        operatorAdminId: order.adminId,
        body: {
          deliveryMode: 'express',
          expressCompanyId: String(companyId),
          trackingNo: `SF-${(sequence += 1).toString()}`,
          lines: [{ orderItemId: String(order.itemIds[0]!), quantity }],
        },
      });

    // Shipped after the request: the approval is refused and nothing moves.
    const late = await paidOrder([{ quantity: 1, unitPrice: '100.00', totalAmount: '100.00' }]);
    const lateRefund = await applied(late);
    await ship(late, 1);
    await expect(
      admin.adminApprove(racer(adminActor(late.adminId)), { id: String(lateRefund) }),
    ).rejects.toMatchObject({ code: 'REFUND_LINE_ALREADY_SHIPPED' });
    expect((await refundRow(lateRefund)).status).toBe('applied');
    expect((await theLine(late)).refundedQuantity).toBe(0);

    // Shipped before the request: a money-only refund of goods the buyer keeps.
    const early = await paidOrder([{ quantity: 1, unitPrice: '100.00', totalAmount: '100.00' }]);
    await ship(early, 1);
    const earlyRefund = await applied(early);
    await admin.adminApprove(racer(adminActor(early.adminId)), { id: String(earlyRefund) });
    expect((await refundRow(earlyRefund)).status).toBe('approved');
    expect((await theLine(early)).refundedQuantity).toBe(1);
  });

  it('REFUND-017 — keeps the units out of the warehouse while a refused refund can be retried, and hands them back when the merchant closes it', async () => {
    const order = await paidOrder([{ quantity: 1, unitPrice: '100.00', totalAmount: '100.00' }]);
    const refundId = await applied(order);
    await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(refundId) });
    expect((await theLine(order)).refundedQuantity).toBe(1);

    gateway.behaviour.failNext = { status: 403, code: 'NOT_ENOUGH', message: '余额不足' };
    const result = await service.executeRefund(racer(), refundId);
    expect((await refundRow(refundId)).status).toBe('failed');
    // Staff are told to top up the merchant account, not to "try again later".
    expect(result.message).toBe('微信支付商户号余额不足，请到商户平台充值后重试');
    expect((await refundRow(refundId)).lastErrorSummary).toBe(result.message);

    // 复核 can still pay it, so shipping the goods now would hand over both.
    expect((await theLine(order)).refundedQuantity).toBe(1);

    await admin.adminReject(racer(adminActor(order.adminId)), {
      id: String(refundId),
      rejectReason: '已线下退款',
    });
    // Closed: the goods are the shop's to ship again.
    expect((await theLine(order)).refundedQuantity).toBe(0);
  });
});
