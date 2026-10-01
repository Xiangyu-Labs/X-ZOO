import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { products, productSkus } from '@shop/db/schema/catalog';
import { orderItems, orders, type OrderItemSnapshot } from '@shop/db/schema/order';
import {
  capitalFlows,
  paymentAttempts,
  paymentCallbacks,
  paymentExceptions,
} from '@shop/db/schema/payment';
import { effects as effectsTable } from '@shop/db/schema/system';
import { users } from '@shop/db/schema/user';
import {
  createTestCtx,
  flushTestRedis,
  forkTestCtx,
  startFakeWechatGateway,
  type FakeWechatGateway,
  type SignedNotification,
  type TestCtx,
} from '@shop/testing';
import { registerCatalogDomain } from '../catalog';
import { resetEffectHandlers } from '../effects';
import type { Actor, Ctx } from '../kernel/context';
import { registerNotificationDomain } from '../notification';
import { wechatConfig } from '../wechat';
import { paymentConfig } from './payment.config';
import * as repo from './payment.repo';
import * as service from './payment.service';

/**
 * The payment path, one caller at a time.
 *
 * The races live next door in `payment.concurrency.int.test.ts`; this file
 * covers what a *single* correctly-signed notification, a single cancel and a
 * single reconciliation must do — which is where most of the invariants are
 * decided, including the awkward ones (money for an order this shop does not
 * have, an amount that disagrees, a merchant that no longer matches).
 *
 * Everything runs against the fake gateway from `@shop/testing`: real RSA
 * signatures, real AEAD, real refusals. Nothing here calls WeChat.
 */

let harness: TestCtx;
let gateway: FakeWechatGateway;

const NOW = '2026-06-01T00:00:00.000Z';
const MUCH_LATER = '2027-06-01T00:00:00.000Z';

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
  // `notify` drops an event nobody registered rather than failing a payment,
  // which is right — and would also let the assertions below pass while
  // proving nothing. Registration is idempotent.
  registerNotificationDomain();
  // The order domain's paid hook commits the sale through the catalogue's stock
  // port, as the web process wires it.
  registerCatalogDomain();
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
});

// ---------------------------------------------------------------------------
// fixtures — local rather than shared, because only `*.repo.ts` and test files
// may import `@shop/db/schema/*`.
// ---------------------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });

function racer(userId?: number): Ctx {
  return forkTestCtx(harness, userId === undefined ? {} : { actor: userActor(userId) });
}

async function configure(mchId = gateway.keys.mchId): Promise<void> {
  await harness.ctx.config.set(paymentConfig, {
    mchId,
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

const snapshot = (): OrderItemSnapshot => ({
  productName: '测试商品',
  productImageUrl: 'https://cdn.example.test/p.jpg',
  productKind: 'physical',
  skuCode: 'SKU-1',
  specText: '默认',
  specValues: {},
});

interface OrderFixture {
  orderId: number;
  orderNo: string;
  userId: number;
  amount: string;
}

async function makePendingOrder(amount = '99.00'): Promise<OrderFixture> {
  sequence += 1;
  const n = sequence;
  const db = harness.ctx.db;

  const [user] = await db
    .insert(users)
    .values({ account: `int-pay-user-${n}` })
    .returning({ id: users.id });
  const [product] = await db
    .insert(products)
    .values({
      name: `测试商品 ${n}`,
      imageUrl: 'https://cdn.example.test/p.jpg',
      status: 'on_shelf',
      freightMode: 'free',
      price: amount,
    })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(productSkus)
    .values({ productId: product!.id, skuCode: `ISKU${n}`, price: amount, stock: 100 })
    .returning({ id: productSkus.id });
  const orderNo = `IO${String(n).padStart(10, '0')}`;
  const [order] = await db
    .insert(orders)
    .values({
      orderNo,
      userId: user!.id,
      platform: 'wechat_mini',
      status: 'pending_payment',
      totalQuantity: 1,
      itemsAmount: amount,
      payableAmount: amount,
      payExpiresAt: new Date(Date.parse(NOW) + 30 * 60_000),
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '广东省',
      receiverCity: '深圳市',
      receiverDetail: '某路 1 号',
    })
    .returning({ id: orders.id });
  await db.insert(orderItems).values({
    orderId: order!.id,
    productId: product!.id,
    skuId: sku!.id,
    itemKey: 'L1',
    quantity: 1,
    unitPrice: amount,
    totalAmount: amount,
    snapshot: snapshot(),
  });

  return { orderId: order!.id, orderNo, userId: user!.id, amount };
}

async function startedPayment(amount = '99.00'): Promise<OrderFixture & { outTradeNo: string }> {
  const order = await makePendingOrder(amount);
  const intent = await service.startPayment(racer(order.userId), {
    orderId: order.orderId,
    channel: 'wechat_mini',
    openid: 'oFakeOpenid',
  });
  return { ...order, outTradeNo: intent.outTradeNo };
}

async function paidAtGateway(amount = '99.00'): Promise<OrderFixture & { outTradeNo: string }> {
  const started = await startedPayment(amount);
  gateway.markPaid(started.outTradeNo);
  return started;
}

function notify(signed: SignedNotification): Promise<service.WebhookResult> {
  return service.handleTransactionNotify(racer(), {
    headers: signed.headers,
    rawBody: signed.rawBody,
  });
}

/** The resource body WeChat encrypts, so a test can bend one field of it. */
function resource(
  outTradeNo: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    appid: gateway.keys.appId,
    mchid: gateway.keys.mchId,
    out_trade_no: outTradeNo,
    transaction_id: `WXTX${outTradeNo}`,
    trade_type: 'JSAPI',
    trade_state: 'SUCCESS',
    trade_state_desc: '支付成功',
    success_time: NOW,
    payer: { openid: 'oFakeOpenid' },
    amount: { total: 9900, payer_total: 9900, currency: 'CNY' },
    ...overrides,
  };
}

/**
 * The order domain's two-call cancel protocol, spelled out (see
 * `payment.concurrency.int.test.ts`).
 */
async function cancelOrder(ctx: Ctx, orderId: number): Promise<'cancelled' | 'paid' | 'blocked'> {
  const state = await service.closeOrderPayments(ctx, orderId);
  if (state === 'paid') return 'paid';
  if (state === 'unknown') return 'blocked';

  return ctx.withTx(async (tx) => {
    const order = await repo.lockOrderForPayment(tx, orderId);
    if (!order || order.status !== 'pending_payment') return 'blocked';
    const again = await service.ensureNoOpenAttempts(tx, orderId);
    if (again === 'paid') return 'paid';
    if (again !== 'closed') return 'blocked';
    await tx
      .update(orders)
      .set({ status: 'cancelled', cancelledAt: ctx.clock.now(), cancelReason: '买家取消' })
      .where(eq(orders.id, orderId));
    return 'cancelled';
  });
}

const orderRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .then((rows) => rows[0]!);

const attemptRows = (orderId: number) =>
  harness.ctx.db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId));
const callbackRows = () => harness.ctx.db.select().from(paymentCallbacks);
const exceptionRows = () => harness.ctx.db.select().from(paymentExceptions);
const effectRows = (eventType: string) =>
  harness.ctx.db.select().from(effectsTable).where(eq(effectsTable.eventType, eventType));
/**
 * The exception notifications recorded so far. `notify` records; the
 * dispatcher sends. The order's own 支付成功 pair is filtered out — a paid
 * order records those on the way in, and they are the order domain's test.
 */
const notificationRows = () =>
  harness.ctx.db
    .select()
    .from(effectsTable)
    .where(eq(effectsTable.scope, 'notification'))
    .then((rows) => rows.filter((row) => row.scopeId.startsWith('admin_payment_exception:')));
const flowRows = (kind: 'order_payment' | 'exception_refund' | 'order_refund') =>
  harness.ctx.db.select().from(capitalFlows).where(eq(capitalFlows.kind, kind));

// ---------------------------------------------------------------------------
// the setting that comes back is the setting that went in
// ---------------------------------------------------------------------------

describe('an all-digit setting survives the round trip through `config_values`', () => {
  /**
   * The column is `jsonb`, and a string that is all digits used to come back as
   * a *number*: `z.string()` refused it and `ConfigService` repaired the field
   * to its default. A WeChat 商户号 is always all digits, so the shop reported
   * 支付尚未配置 with a filled-in form and no explanation. Fixed in `@shop/db`;
   * this asserts it from the payment side against a real database rather than a
   * schema.
   */
  it('keeps a numeric 商户号 a string, all the way onto the attempt', async () => {
    // `beforeEach` already wrote it; the fake merchant id is `1900000001`,
    // which is exactly the shape that used to break.
    expect(gateway.keys.mchId).toMatch(/^\d+$/);
    expect((await racer().config.get(paymentConfig)).mchId).toBe(gateway.keys.mchId);

    // And the attempt records it, which is what PAYC-005 compares against.
    const started = await startedPayment();
    expect((await attemptRows(started.orderId))[0]!.mchId).toBe(gateway.keys.mchId);
  });
});

// ---------------------------------------------------------------------------
// PAY-004 / CLIENT-001 — the ordinary successful payment
// ---------------------------------------------------------------------------

describe('PAY-004 — a valid notification settles the order exactly once', () => {
  it('pays the order, books the flow and records the hand-off effect', async () => {
    const paid = await paidAtGateway();

    const result = await notify(
      gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo }),
    );
    expect(result).toEqual({ status: 200, body: { code: 'SUCCESS', message: '成功' } });

    const order = await orderRow(paid.orderId);
    expect(order.status).toBe('paid');
    expect(order.paidAmount).toBe(paid.amount);
    expect(order.paidAt).not.toBeNull();
    // The gateway's transaction id, not our merchant number: it is the only
    // handle a human can give WeChat support.
    expect(order.transactionNo).toBe(gateway.transactions.get(paid.outTradeNo)!.transactionId);

    const flows = await flowRows('order_payment');
    expect(flows).toHaveLength(1);
    expect(flows[0]!.direction).toBe('in');
    expect(flows[0]!.amount).toBe(paid.amount);
    expect(flows[0]!.reference).toBe(paid.outTradeNo);

    expect(await effectRows('order.paid')).toHaveLength(1);
    expect(await exceptionRows()).toEqual([]);
    expect((await attemptRows(paid.orderId))[0]!.status).toBe('paid');

    // The sale is committed in the same transaction: the fixture never
    // reserved, so only `sales` moves.
    const [item] = await harness.ctx.db
      .select({ skuId: orderItems.skuId })
      .from(orderItems)
      .where(eq(orderItems.orderId, paid.orderId));
    const [sku] = await harness.ctx.db
      .select({ stock: productSkus.stock, sales: productSkus.sales })
      .from(productSkus)
      .where(eq(productSkus.id, item!.skuId));
    expect(sku).toEqual({ stock: 100, sales: 1 });

    const callbacks = await callbackRows();
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]!.signatureVerified).toBe(true);
    expect(callbacks[0]!.result).toBe(`paid: order ${paid.orderId}`);
  });

  it('records a non-SUCCESS notification without acting on it', async () => {
    const started = await startedPayment();
    const signed = gateway.signTransactionNotification({
      outTradeNo: started.outTradeNo,
      resource: resource(started.outTradeNo, { trade_state: 'CLOSED' }),
    });

    expect((await notify(signed)).status).toBe(200);
    expect((await callbackRows())[0]!.result).toBe('ignored: trade_state=CLOSED');
    expect((await orderRow(started.orderId)).status).toBe('pending_payment');
    expect(await flowRows('order_payment')).toEqual([]);
  });
});

describe('CLIENT-001 — what the cashier is told', () => {
  it('reports 已支付 instead of minting a second payment intent', async () => {
    const paid = await paidAtGateway();
    await notify(gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo }));
    const before = gateway.calls.length;

    const intent = await service.startPayment(racer(paid.userId), {
      orderId: paid.orderId,
      channel: 'wechat_mini',
      openid: 'oFakeOpenid',
    });

    expect(intent.alreadyPaid).toBe(true);
    expect(intent.jsapi).toBeNull();
    expect(intent.h5Url).toBeNull();
    expect(intent.outTradeNo).toBe(paid.outTradeNo);
    // Nothing was asked of WeChat: a paid order is a database fact.
    expect(gateway.calls).toHaveLength(before);
    expect(await attemptRows(paid.orderId)).toHaveLength(1);
  });

  it('answers the cashier poll from the database, never from the gateway', async () => {
    const paid = await paidAtGateway();
    await notify(gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo }));
    const before = gateway.calls.length;

    const status = await service.paymentStatus(racer(paid.userId), paid.outTradeNo);
    expect(status.paid).toBe(true);
    expect(status.status).toBe('paid');
    expect(gateway.calls).toHaveLength(before);
  });

  it('never shows one shopper another shopper’s payment', async () => {
    const paid = await paidAtGateway();
    const stranger = await makePendingOrder();
    await expect(
      service.paymentStatus(racer(stranger.userId), paid.outTradeNo),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTEMPT_NOT_FOUND' });
  });

  it('refuses to start a payment on an order that is already cancelled', async () => {
    const started = await startedPayment();
    expect(await cancelOrder(racer(started.userId), started.orderId)).toBe('cancelled');

    await expect(
      service.startPayment(racer(started.userId), {
        orderId: started.orderId,
        channel: 'wechat_mini',
        openid: 'oFakeOpenid',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_ORDER_NOT_PAYABLE' });
  });
});

// ---------------------------------------------------------------------------
// PAY-001 / PAY-002 — money this shop cannot book
// ---------------------------------------------------------------------------

describe('PAY-001 — a notification for an order this shop does not have', () => {
  /**
   * Acknowledging an unknown order and doing nothing is where "we were paid and
   * nobody noticed" starts. So it is acknowledged — WeChat must stop retrying —
   * but the money becomes a `payment_exceptions` row and an automatic refund
   * effect. And there is still no side effect on an order we do not have: no
   * order changes, no capital flow, no `order.paid`.
   */
  it('acknowledges it, touches no order, and books it as an exception to refund', async () => {
    const started = await startedPayment();
    const signed = gateway.signTransactionNotification({
      outTradeNo: started.outTradeNo,
      resource: resource('OT-NOT-OURS'),
    });

    expect((await notify(signed)).status).toBe(200);

    const exceptions = await exceptionRows();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.reason).toBe('unmatched_payment');
    expect(exceptions[0]!.orderId).toBeNull();
    expect(await effectRows('payment.exception.refund')).toHaveLength(1);

    expect((await orderRow(started.orderId)).status).toBe('pending_payment');
    expect(await flowRows('order_payment')).toEqual([]);
    expect(await effectRows('order.paid')).toEqual([]);
  });
});

describe('PAY-002 — an order that is already paid', () => {
  it('treats the same transaction arriving again as a replay', async () => {
    const paid = await paidAtGateway();
    await notify(gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo }));
    // A different notification id carrying the same transaction: a genuine new
    // delivery, not a retry of one we already acknowledged.
    await notify(gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo }));

    expect(await callbackRows()).toHaveLength(2);
    expect((await callbackRows()).filter((r) => r.result === 'ignored: already paid')).toHaveLength(
      1,
    );
    expect(await flowRows('order_payment')).toHaveLength(1);
    expect(await effectRows('order.paid')).toHaveLength(1);
    expect(await exceptionRows()).toEqual([]);
  });

  it('treats a *different* transaction on a paid attempt as a second real payment', async () => {
    const paid = await paidAtGateway();
    await notify(gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo }));

    const second = gateway.signTransactionNotification({
      outTradeNo: paid.outTradeNo,
      resource: resource(paid.outTradeNo, { transaction_id: 'WXTX-SECOND' }),
    });
    expect((await notify(second)).status).toBe(200);

    // Money arrived twice; the shop owes one of them back. It is never silently
    // kept and never booked against the order a second time.
    const exceptions = await exceptionRows();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.reason).toBe('duplicate_payment');
    expect(await effectRows('payment.exception.refund')).toHaveLength(1);
    expect(await flowRows('order_payment')).toHaveLength(1);
    expect((await orderRow(paid.orderId)).paidAmount).toBe(paid.amount);
  });

  /**
   * The automatic refund above does not make this redundant: it can fail, and
   * somebody has to know money arrived that the shop cannot book.
   */
  it('puts the exception on an operator’s list, once however often it is delivered', async () => {
    const paid = await paidAtGateway();
    await notify(gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo }));
    const second = () =>
      gateway.signTransactionNotification({
        outTradeNo: paid.outTradeNo,
        resource: resource(paid.outTradeNo, { transaction_id: 'WXTX-SECOND' }),
      });
    await notify(second());
    // Delivered again: the unique index finds the exception already there and
    // nobody is woken a second time.
    await notify(second());

    const [exception] = await exceptionRows();
    const rows = await notificationRows();
    expect(rows.map((row) => row.scopeId)).toEqual([
      `admin_payment_exception:payment_exception:${exception!.id}`,
    ]);
    expect(rows[0]).toMatchObject({ scope: 'notification', status: 'pending' });
    expect(rows[0]?.payload).toMatchObject({
      event: 'admin_payment_exception',
      data: { exceptionId: exception!.id, amount: exception!.paidAmount, reason: '重复支付' },
    });
    // An admin event carries no recipient: fan-out resolves whoever holds the
    // permission atom at the time it is sent.
    expect(rows[0]?.payload).not.toHaveProperty('userId');
  });

  it('announces no exception when the settlement transaction rolls back', async () => {
    const paid = await paidAtGateway();
    await notify(gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo }));
    const before = await notificationRows();

    const second = gateway.signTransactionNotification({
      outTradeNo: paid.outTradeNo,
      resource: resource(paid.outTradeNo, { transaction_id: 'WXTX-ROLLBACK' }),
    });
    const broken: Ctx = { ...racer(), withTx: () => Promise.reject(new Error('数据库暂时不可用')) };
    const result = await service.handleTransactionNotify(broken, {
      headers: second.headers,
      rawBody: second.rawBody,
    });
    expect(result.status).toBe(500);

    expect(await exceptionRows()).toHaveLength(0);
    expect(await notificationRows()).toEqual(before);
  });
});

describe('PAY-003 — a failure on our side asks WeChat to deliver again', () => {
  it('answers 500 FAIL rather than acknowledging money it did not record', async () => {
    const paid = await paidAtGateway();
    const signed = gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo });
    // The database refuses; nothing commits. Acknowledging here would lose the
    // payment forever, because WeChat never delivers an acknowledged event
    // again.
    const broken: Ctx = { ...racer(), withTx: () => Promise.reject(new Error('数据库暂时不可用')) };

    const result = await service.handleTransactionNotify(broken, {
      headers: signed.headers,
      rawBody: signed.rawBody,
    });
    expect(result.status).toBe(500);
    expect(result.body.code).toBe('FAIL');

    // …and the retry that follows settles it, which is the point of the 500.
    expect((await notify(signed)).status).toBe(200);
    expect((await orderRow(paid.orderId)).status).toBe('paid');
  });

  it('answers 401 for a signature it cannot verify, before touching the database', async () => {
    const paid = await paidAtGateway();
    const signed = gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo });

    const tampered = {
      headers: { ...signed.headers, 'wechatpay-signature': 'ZmFrZQ==' },
      rawBody: signed.rawBody,
    };
    const result = await service.handleTransactionNotify(racer(), tampered);

    expect(result.status).toBe(401);
    expect(await callbackRows()).toEqual([]);
    expect((await orderRow(paid.orderId)).status).toBe('pending_payment');
  });
});

// ---------------------------------------------------------------------------
// GATEWAY-001 — the amount is part of the signature check
// ---------------------------------------------------------------------------

describe('GATEWAY-001 — an amount that disagrees is never booked', () => {
  const cases = [
    // `total` is what is compared. A short `payer_total` alone is a WeChat-side
    // discount, and that is a payment (PAY-013).
    { label: 'short', amount: { total: 9800, payer_total: 9800, currency: 'CNY' }, held: '98.00' },
    {
      label: 'over',
      amount: { total: 19900, payer_total: 19900, currency: 'CNY' },
      held: '199.00',
    },
  ];

  for (const { label, amount, held } of cases) {
    it(`refuses a ${label} amount, however well signed it is`, async () => {
      const started = await startedPayment();
      gateway.markPaid(started.outTradeNo);
      const signed = gateway.signTransactionNotification({
        outTradeNo: started.outTradeNo,
        resource: resource(started.outTradeNo, { amount }),
      });

      // Acknowledged — the signature was genuine, so retrying changes nothing —
      // but the order is not paid and the money is on a human's list.
      expect((await notify(signed)).status).toBe(200);

      const order = await orderRow(started.orderId);
      expect(order.status).toBe('pending_payment');
      expect(order.paidAt).toBeNull();
      expect(await flowRows('order_payment')).toEqual([]);
      expect(await effectRows('order.paid')).toEqual([]);

      const exceptions = await exceptionRows();
      expect(exceptions).toHaveLength(1);
      expect(exceptions[0]!.reason).toBe('amount_mismatch');
      // What the gateway holds, so the automatic refund sends back all of it.
      expect(exceptions[0]!.paidAmount).toBe(held);
    });
  }

  it('closes the attempt, so the order can still be cancelled and is not re-queried forever', async () => {
    const started = await startedPayment();
    gateway.markPaid(started.outTradeNo);
    await notify(
      gateway.signTransactionNotification({
        outTradeNo: started.outTradeNo,
        resource: resource(started.outTradeNo, {
          amount: { total: 9800, payer_total: 9800, currency: 'CNY' },
        }),
      }),
    );

    const [attempt] = await attemptRows(started.orderId);
    expect(attempt!.status).toBe('closed');
    expect(attempt!.closedConfirmedAt).not.toBeNull();
    expect(await service.reconcileAttempt(racer(), attempt!.id)).toBe('closed');
    expect(await cancelOrder(racer(started.userId), started.orderId)).toBe('cancelled');
    expect(await exceptionRows()).toHaveLength(1);
  });

  it('answers closed — not paid — when the sweep is the one that finds the disagreement', async () => {
    const started = await startedPayment();
    // The gateway holds a different total than the attempt asked for.
    gateway.transactions.get(started.outTradeNo)!.amountFen = 9800;
    gateway.markPaid(started.outTradeNo);
    const id = (await attemptRows(started.orderId))[0]!.id;

    expect(await service.reconcileAttempt(racer(), id)).toBe('closed');

    expect((await attemptRows(started.orderId))[0]!.status).toBe('closed');
    expect((await exceptionRows())[0]!.reason).toBe('amount_mismatch');
    expect((await orderRow(started.orderId)).status).toBe('pending_payment');
    expect(await cancelOrder(racer(started.userId), started.orderId)).toBe('cancelled');
  });

  /**
   * A body with no usable amount is a different animal from a wrong one. There
   * is nothing to book and nothing to refund — a refund is made of an amount —
   * and `payment_exceptions_amount_positive` would refuse the row anyway. The
   * delivery is acknowledged rather than 500'd, because the retry would carry
   * the *same bytes* and fail identically for as long as WeChat keeps trying.
   */
  for (const { label, amount } of [
    { label: 'unparseable', amount: { total: '九十九元', currency: 'CNY' } },
    { label: 'absent', amount: {} },
    { label: 'zero', amount: { total: 0, payer_total: 0, currency: 'CNY' } },
  ]) {
    it(`parks an ${label} amount on the callbacks table instead of looping`, async () => {
      const started = await startedPayment();
      gateway.markPaid(started.outTradeNo);
      const signed = gateway.signTransactionNotification({
        outTradeNo: started.outTradeNo,
        resource: resource(started.outTradeNo, { amount }),
      });

      expect((await notify(signed)).status).toBe(200);
      expect((await callbackRows())[0]!.result).toBe('ignored: invalid amount');
      expect((await orderRow(started.orderId)).status).toBe('pending_payment');
      expect(await exceptionRows()).toEqual([]);
      expect(await flowRows('order_payment')).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// PAY-013 — a WeChat-side discount is still the whole payment
// ---------------------------------------------------------------------------

describe('PAY-013 — a payment a WeChat 立减 or 代金券 paid part of', () => {
  /** 99.00 asked for; WeChat's own promotion covered 5.00 of it. */
  const DISCOUNT_FEN = 500;

  it('pays the order from the notification: total is compared, payer_total is only noted', async () => {
    const started = await startedPayment();
    gateway.markPaid(started.outTradeNo, { discountFen: DISCOUNT_FEN });

    const result = await notify(
      gateway.signTransactionNotification({ outTradeNo: started.outTradeNo }),
    );
    expect(result.status).toBe(200);

    const order = await orderRow(started.orderId);
    expect(order.status).toBe('paid');
    expect(order.paidAmount).toBe('99.00');
    expect(await exceptionRows()).toEqual([]);

    const [attempt] = await attemptRows(started.orderId);
    expect(attempt!.status).toBe('paid');
    expect(attempt!.lastResult).toContain('payer_total 9400 of 9900');

    const [flow] = await flowRows('order_payment');
    expect(flow!.amount).toBe('99.00');
    expect(flow!.note).toContain('微信优惠 5.00');
  });

  it('pays it the same way when the reconciliation sweep finds it', async () => {
    const started = await startedPayment();
    gateway.markPaid(started.outTradeNo, { discountFen: DISCOUNT_FEN });
    const id = (await attemptRows(started.orderId))[0]!.id;

    expect(await service.reconcileAttempt(racer(), id)).toBe('paid');

    expect((await orderRow(started.orderId)).status).toBe('paid');
    expect(await exceptionRows()).toEqual([]);
    // …and the order is then not cancellable, because it is paid.
    expect(await cancelOrder(racer(started.userId), started.orderId)).toBe('paid');
  });

  it('refunds an exception with the original transaction total, which the gateway accepts', async () => {
    const started = await startedPayment();
    expect(await cancelOrder(racer(started.userId), started.orderId)).toBe('cancelled');
    // The money lands anyway, with a WeChat discount on it.
    gateway.markPaid(started.outTradeNo, { discountFen: DISCOUNT_FEN });
    gateway.behaviour.refundStatus = 'SUCCESS';
    await notify(gateway.signTransactionNotification({ outTradeNo: started.outTradeNo }));

    const [exception] = await exceptionRows();
    expect(exception!.reason).toBe('cancelled_order_payment');
    expect(exception!.paidAmount).toBe('99.00');

    // The fake refuses a refund whose `amount.total` is not the transaction's
    // total, as WeChat does; payer_total (94.00) here was `refund_failed`.
    const settled = await service.refundException(racer(), exception!.id);
    expect(settled.status).toBe('refunded');
    const refund = gateway.refunds.get(settled.refundNo!)!;
    expect(refund.refundFen).toBe(9900);
    expect(refund.totalFen).toBe(9900);
    expect((await flowRows('exception_refund'))[0]!.amount).toBe('99.00');
  });
});

// ---------------------------------------------------------------------------
// PAY-014 — an attempt already closed never becomes a paid order
// ---------------------------------------------------------------------------

describe('PAY-014 — money for an attempt that was already closed', () => {
  it('is an exception to refund, not a second way to pay the order', async () => {
    const started = await startedPayment();
    const id = (await attemptRows(started.orderId))[0]!.id;
    await racer().withTx((tx) =>
      repo.markAttemptClosed(tx, id, { confirmedAt: new Date(NOW), lastResult: 'closed: test' }),
    );
    gateway.markPaid(started.outTradeNo);

    expect(
      (await notify(gateway.signTransactionNotification({ outTradeNo: started.outTradeNo })))
        .status,
    ).toBe(200);

    const order = await orderRow(started.orderId);
    expect(order.status).toBe('pending_payment');
    expect(order.paidAt).toBeNull();
    expect(await flowRows('order_payment')).toEqual([]);
    expect((await attemptRows(started.orderId))[0]!.status).toBe('closed');
    const exceptions = await exceptionRows();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.reason).toBe('unmatched_payment');
    expect(await effectRows('payment.exception.refund')).toHaveLength(1);
  });
});

describe('PAY-010 — 支付失败 (PAYERROR) is closed at the gateway, like any close', () => {
  it('asks the gateway to close it, and answers closed only on its confirmation', async () => {
    const started = await startedPayment();
    gateway.setTradeState(started.outTradeNo, 'PAYERROR');
    const id = (await attemptRows(started.orderId))[0]!.id;
    gateway.calls.length = 0;

    expect(await service.reconcileAttempt(racer(), id)).toBe('closed');

    expect(gateway.calls.map((call) => call.path)).toContain(
      `/v3/pay/transactions/out-trade-no/${started.outTradeNo}/close`,
    );
    expect(gateway.transactions.get(started.outTradeNo)!.tradeState).toBe('CLOSED');
    expect((await attemptRows(started.orderId))[0]!.status).toBe('closed');
  });

  it('keeps it open, without looping, when the gateway refuses the close', async () => {
    const started = await startedPayment();
    gateway.setTradeState(started.outTradeNo, 'PAYERROR');
    // The close is the first call `closeOrderPayments` makes; refuse it.
    gateway.behaviour.failNext = { status: 400, code: 'INVALID_REQUEST', message: '拒绝关单' };

    expect(await service.closeOrderPayments(racer(), started.orderId)).toBe('unknown');

    const [attempt] = await attemptRows(started.orderId);
    expect(attempt!.status).toBe('unknown');
    expect(attempt!.lastResult).toMatch(/PAYERROR/);
    // The next pass asks again, the gateway closes it, and the cancel goes on.
    expect(await cancelOrder(racer(started.userId), started.orderId)).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// PAYC-001 … PAYC-005 — the attempt row is the money's memory
// ---------------------------------------------------------------------------

describe('PAYC-001 — a create in flight is never stepped over', () => {
  /**
   * `creating` is the row `startPayment` writes *before* it calls WeChat, and
   * for as long as it stands a gateway order may or may not exist. The cancel
   * may not guess either way: it has to settle the attempt with the gateway
   * first, and only a confirmed answer lets anything be released.
   */
  async function inFlightAttempt(order: OrderFixture, outTradeNo: string) {
    const attempt = await racer().withTx((tx) =>
      repo.insertAttempt(tx, {
        orderId: order.orderId,
        outTradeNo,
        channel: 'wechat_mini',
        mchId: gateway.keys.mchId,
        appId: gateway.keys.appId,
        amount: order.amount,
        payerUserId: order.userId,
        context: { tradeType: 'JSAPI', openid: 'oFakeOpenid' },
      }),
    );
    expect(attempt!.status).toBe('creating');
    return attempt!;
  }

  it('settles it with the gateway first, and cancels only on a confirmed negative', async () => {
    const order = await makePendingOrder();
    await inFlightAttempt(order, 'OT-IN-FLIGHT');

    expect(await cancelOrder(racer(order.userId), order.orderId)).toBe('cancelled');

    // It asked, and the gateway said it has no such order — the one answer that
    // makes releasing safe, because nothing can ever arrive under that number.
    expect(gateway.calls.some((call) => call.path.includes('OT-IN-FLIGHT'))).toBe(true);
    const [attempt] = await attemptRows(order.orderId);
    expect(attempt!.status).toBe('closed');
    expect(attempt!.lastResult).toBe('closed: gateway has no such order');
  });

  it('releases nothing while the gateway will not say', async () => {
    const order = await makePendingOrder();
    await inFlightAttempt(order, 'OT-SILENT');
    gateway.behaviour.dropNext = true;

    expect(await cancelOrder(racer(order.userId), order.orderId)).toBe('blocked');

    expect((await orderRow(order.orderId)).status).toBe('pending_payment');
    const [attempt] = await attemptRows(order.orderId);
    expect(attempt!.status).toBe('unknown');
  });
});

describe('PAYC-002 — a create whose answer was lost', () => {
  it('keeps the attempt unknown, and the order neither paid nor cancellable', async () => {
    const order = await makePendingOrder();
    gateway.behaviour.dropNext = true;

    await expect(
      service.startPayment(racer(order.userId), {
        orderId: order.orderId,
        channel: 'wechat_mini',
        openid: 'oFakeOpenid',
      }),
    ).rejects.toBeInstanceOf(Error);

    const [attempt] = await attemptRows(order.orderId);
    expect(attempt!.status).toBe('unknown');
    expect(attempt!.lastResult).toMatch(/create unknown/);

    const orderAfter = await orderRow(order.orderId);
    expect(orderAfter.status).toBe('pending_payment');
    expect(orderAfter.paidAt).toBeNull();

    // The only way out is asking. The gateway never took this order, so the
    // query is a confirmed negative and the cancel may then proceed.
    expect(await service.reconcileAttempt(racer(), attempt!.id)).toBe('closed');
    expect(await cancelOrder(racer(order.userId), order.orderId)).toBe('cancelled');
  });

  it('books the payment when the answer that was lost was "yes"', async () => {
    const started = await startedPayment();
    // The gateway did take the order; pretend our side never learnt the result.
    const id = await attemptId(started.orderId);
    await racer().withTx((tx) => repo.markAttemptUnknown(tx, id!, 'create unknown: 超时'));
    gateway.markPaid(started.outTradeNo);

    expect(await cancelOrder(racer(started.userId), started.orderId)).toBe('paid');

    const order = await orderRow(started.orderId);
    expect(order.status).toBe('paid');
    expect(await flowRows('order_payment')).toHaveLength(1);
  });
});

describe('PAYC-003 — repeated taps', () => {
  it('keeps one attempt and one merchant order number', async () => {
    const order = await makePendingOrder();
    const first = await service.startPayment(racer(order.userId), {
      orderId: order.orderId,
      channel: 'wechat_mini',
      openid: 'oFakeOpenid',
    });
    const second = await service.startPayment(racer(order.userId), {
      orderId: order.orderId,
      channel: 'wechat_mini',
      openid: 'oFakeOpenid',
    });

    expect(second.outTradeNo).toBe(first.outTradeNo);
    expect(await attemptRows(order.orderId)).toHaveLength(1);
    expect(gateway.transactions.size).toBe(1);
    // Neither tap completed or cancelled anything.
    expect((await orderRow(order.orderId)).status).toBe('pending_payment');
  });

  it('re-uses the frozen number rather than opening a second gateway order after a lost answer', async () => {
    const started = await startedPayment();
    const id = await attemptId(started.orderId);
    await racer().withTx((tx) => repo.markAttemptUnknown(tx, id!, 'query unknown: 超时'));

    const again = await service.startPayment(racer(started.userId), {
      orderId: started.orderId,
      channel: 'wechat_mini',
      openid: 'oFakeOpenid',
    });
    expect(again.outTradeNo).toBe(started.outTradeNo);
    expect(gateway.transactions.size).toBe(1);
  });
});

describe('PAYC-004 — the attempt is immutable', () => {
  it('refuses a replay that disagrees about the channel, and leaves the row alone', async () => {
    const started = await startedPayment();

    await expect(
      service.startPayment(racer(started.userId), {
        orderId: started.orderId,
        channel: 'wechat_h5',
        returnUrl: 'https://shop.example.test/pay/return',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTEMPT_CONFLICT' });

    const [attempt] = await attemptRows(started.orderId);
    expect(attempt!.channel).toBe('wechat_mini');
    expect(attempt!.outTradeNo).toBe(started.outTradeNo);
    expect(gateway.transactions.size).toBe(1);
  });

  it('refuses a replay from a different payer', async () => {
    const started = await startedPayment();
    const stranger = await makePendingOrder();

    await expect(
      service.startPayment(racer(stranger.userId), {
        orderId: started.orderId,
        channel: 'wechat_mini',
        openid: 'oSomeoneElse',
      }),
      // Not even a conflict: the order is not this shopper's to pay for.
    ).rejects.toMatchObject({ code: 'PAYMENT_ORDER_NOT_FOUND' });
  });
});

describe('PAYC-005 — the merchant on the attempt is no longer the configured one', () => {
  it('stops the cancellation, asks WeChat nothing, and leaves a message for a human', async () => {
    const started = await startedPayment();
    // The shop was re-pointed at another 商户号 — a migration, or a typo.
    await configure('1900000099');
    const before = gateway.calls.length;

    expect(await cancelOrder(racer(started.userId), started.orderId)).toBe('blocked');

    // No close, no query: asking the wrong merchant would produce a confirmed
    // "no such order" that is a lie about where the money is.
    expect(gateway.calls).toHaveLength(before);

    const [attempt] = await attemptRows(started.orderId);
    expect(attempt!.status).toBe('unknown');
    expect(attempt!.lastResult).toContain('请人工核对后处理');

    const order = await orderRow(started.orderId);
    expect(order.status).toBe('pending_payment');
    expect(order.cancelledAt).toBeNull();
  });

  it('refuses to reconcile it either, so the sweep cannot close it by accident', async () => {
    const started = await startedPayment();
    await configure('1900000099');
    harness.clock.set(MUCH_LATER);
    const before = gateway.calls.length;

    const id = await attemptId(started.orderId);
    expect(await service.reconcileAttempt(racer(), id!)).toBe('unknown');
    expect(gateway.calls).toHaveLength(before);
  });
});

async function attemptId(orderId: number): Promise<number | null> {
  const rows = await attemptRows(orderId);
  return rows[0]?.id ?? null;
}
