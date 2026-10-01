import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { admins } from '@shop/db/schema/auth';
import { products, productSkus } from '@shop/db/schema/catalog';
import { orderItems, orders, type OrderItemSnapshot } from '@shop/db/schema/order';
import {
  capitalFlows,
  paymentAttempts,
  paymentCallbacks,
  paymentExceptions,
} from '@shop/db/schema/payment';
import { refundLogs, refunds } from '@shop/db/schema/refund';
import { effects as effectsTable } from '@shop/db/schema/system';
import { users } from '@shop/db/schema/user';
import {
  createTestCtx,
  flushTestRedis,
  forkTestCtx,
  startFakeWechatGateway,
  type FakeWechatGateway,
  type TestCtx,
} from '@shop/testing';
import { resetEffectHandlers } from '../effects';
import { registerNotificationDomain } from '../notification';
import type { Actor, Ctx } from '../kernel/context';
import { installFulfilmentHooks } from '../order';
import { registerStockPort, resetOrderPorts } from '../order/ports';
import {
  handleTransactionNotify,
  paymentConfig,
  PAYMENT_NOTIFY_MISMATCH_EVENT,
  registerPaymentNotificationEvents,
  startPayment,
} from '../payment';
import { wechatConfig } from '../wechat';
import * as admin from './refund.admin';
import { REFUND_EXCEPTION_EVENT, registerRefundNotificationEvents } from './refund.notifications';
import * as repo from './refund.repo';
import * as service from './refund.service';

/**
 * The two WeChat Pay webhooks, read as an attacker.
 *
 * Every notification here carries a *genuine* signature from the fake
 * gateway's platform key and a resource sealed with the shop's own APIv3 key —
 * so each case is one the verifier lets through, and the question is what the
 * code does with a well-signed body that is nonetheless wrong: meant for the
 * other endpoint, naming another merchant, or stating an amount that is not
 * the one we froze.
 *
 * Each wrong body has a case that it is refused and cases that pin *how*: 200,
 * no callback row for a misroute, and an operator notification (never a
 * settlement, never an automatic refund) for a merchant or amount that does not
 * match.
 */

let harness: TestCtx;
let gateway: FakeWechatGateway;

const NOW = '2026-06-01T00:00:00.000Z';
const OTHER_MCH_ID = '1900000099';

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
  // See refund.concurrency.int.test.ts: after a truncate the config cache
  // still holds the old keys, and `set` writes only what changed.
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
  resetEffectHandlers();
  // The operator notifications a wrong merchant or amount raises are asserted
  // below; `notify` drops an event nobody registered.
  registerNotificationDomain();
  registerPaymentNotificationEvents();
  registerRefundNotificationEvents();
  resetOrderPorts();
  installFulfilmentHooks();
  registerStockPort({
    async reserve() {
      return [];
    },
    async commit() {},
    async release() {},
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

const snapshot: OrderItemSnapshot = {
  productName: '测试商品',
  productImageUrl: 'https://cdn.example.test/p.jpg',
  productKind: 'physical',
  skuCode: 'SKU-1',
  specText: '默认',
  specValues: {},
};

interface StartedOrder {
  orderId: number;
  userId: number;
  adminId: number;
  itemId: number;
  outTradeNo: string;
}

/**
 * One order, two units at 50.00, with a payment attempt submitted to the fake
 * gateway and the money taken there — but no notification delivered yet.
 */
async function paidAtGateway(): Promise<StartedOrder> {
  sequence += 1;
  const n = sequence;
  const db = harness.ctx.db;

  const [user] = await db
    .insert(users)
    .values({ account: `webhook-user-${n}` })
    .returning({ id: users.id });
  const [operator] = await db
    .insert(admins)
    .values({
      account: `webhook-admin-${n}`,
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
      price: '50.00',
    })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(productSkus)
    .values({ productId: product!.id, skuCode: `WSKU${n}`, price: '50.00', stock: 100 })
    .returning({ id: productSkus.id });
  const [order] = await db
    .insert(orders)
    .values({
      orderNo: `WO${String(n).padStart(10, '0')}`,
      userId: user!.id,
      platform: 'wechat_mini',
      status: 'pending_payment',
      totalQuantity: 2,
      itemsAmount: '100.00',
      payableAmount: '100.00',
      payExpiresAt: new Date(Date.parse(NOW) + 30 * 60_000),
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '广东省',
      receiverCity: '深圳市',
      receiverDetail: '某路 1 号',
    })
    .returning({ id: orders.id });
  const [item] = await db
    .insert(orderItems)
    .values({
      orderId: order!.id,
      productId: product!.id,
      skuId: sku!.id,
      itemKey: 'L1',
      quantity: 2,
      unitPrice: '50.00',
      totalAmount: '100.00',
      snapshot,
    })
    .returning({ id: orderItems.id });

  const intent = await startPayment(racer(userActor(user!.id)), {
    orderId: order!.id,
    channel: 'wechat_mini',
    openid: 'oFakeOpenid',
  });
  gateway.markPaid(intent.outTradeNo);

  return {
    orderId: order!.id,
    userId: user!.id,
    adminId: operator!.id,
    itemId: item!.id,
    outTradeNo: intent.outTradeNo,
  };
}

/** The same, with the payment notification delivered: a genuinely paid order. */
async function paidOrder(): Promise<StartedOrder> {
  const started = await paidAtGateway();
  const ack = await handleTransactionNotify(
    racer(),
    gateway.signTransactionNotification({ outTradeNo: started.outTradeNo }),
  );
  expect(ack.status).toBe(200);
  expect((await orderRow(started.orderId)).status).toBe('paid');
  return started;
}

/** One unit refunded, approved and sent: `processing` at the gateway. */
async function processingRefund(order: StartedOrder): Promise<{ id: number; outRefundNo: string }> {
  const applied = await service.apply(racer(userActor(order.userId)), {
    orderId: String(order.orderId),
    kind: 'refund_only',
    lines: [{ orderItemId: String(order.itemId), quantity: 1 }],
    reason: '不想要了',
    images: [],
    includeFreight: false,
  });
  const id = Number(applied.id);
  await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });
  const result = await service.executeRefund(racer(), id);
  expect(result.status).toBe('processing');
  const row = await repo.findRefund(harness.ctx.db, id);
  return { id, outRefundNo: row!.outRefundNo };
}

/** The decrypted transaction resource WeChat would send, one field bent. */
function transactionResource(
  outTradeNo: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const transaction = gateway.transactions.get(outTradeNo)!;
  return {
    appid: gateway.keys.appId,
    mchid: gateway.keys.mchId,
    out_trade_no: outTradeNo,
    transaction_id: transaction.transactionId,
    trade_type: 'JSAPI',
    trade_state: 'SUCCESS',
    trade_state_desc: '支付成功',
    success_time: NOW,
    payer: { openid: 'oFakeOpenid' },
    amount: { total: 10000, payer_total: 10000, currency: 'CNY' },
    ...overrides,
  };
}

/** The decrypted refund resource WeChat would send, one field bent. */
function refundResource(
  outRefundNo: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const refund = gateway.refunds.get(outRefundNo)!;
  return {
    mchid: gateway.keys.mchId,
    out_trade_no: refund.outTradeNo,
    transaction_id: refund.transactionId,
    out_refund_no: refund.outRefundNo,
    refund_id: refund.refundId,
    refund_status: 'SUCCESS',
    success_time: NOW,
    user_received_account: '支付用户零钱',
    amount: {
      total: refund.totalFen,
      refund: refund.refundFen,
      payer_total: refund.totalFen,
      payer_refund: refund.refundFen,
    },
    ...overrides,
  };
}

const orderRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .then((rows) => rows[0]!);

const refundRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(refunds)
    .where(eq(refunds.id, id))
    .then((rows) => rows[0]!);

const callbackRows = () => harness.ctx.db.select().from(paymentCallbacks);
const notificationRows = (event: string) =>
  harness.ctx.db
    .select({ scopeId: effectsTable.scopeId, payload: effectsTable.payload })
    .from(effectsTable)
    .then((rows) => rows.filter((row) => row.scopeId.startsWith(`${event}:`)));
const refundLogRows = (refundId: number) =>
  harness.ctx.db.select().from(refundLogs).where(eq(refundLogs.refundId, refundId));
const flowRows = (kind: 'order_payment' | 'order_refund') =>
  harness.ctx.db.select().from(capitalFlows).where(eq(capitalFlows.kind, kind));

// ---------------------------------------------------------------------------
// an event delivered to the endpoint it was not meant for
// ---------------------------------------------------------------------------

describe('a signed event delivered to the other webhook', () => {
  it('books nothing when a refund notification reaches the payment endpoint', async () => {
    const order = await paidOrder();
    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'SUCCESS');
    const signed = gateway.signRefundNotification({ outRefundNo: refund.outRefundNo });

    const result = await handleTransactionNotify(racer(), signed);

    // Acknowledged, because the resource has no `trade_state` — which is the
    // only reason nothing happened. The refund is still in flight, and no
    // second payment was booked for the order.
    expect(result.status).toBe(200);
    expect((await refundRow(refund.id)).status).toBe('processing');
    expect(await flowRows('order_payment')).toHaveLength(1);
    expect(await flowRows('order_refund')).toEqual([]);
    expect((await orderRow(order.orderId)).refundedAmount).toBe('0.00');
  });

  it('books nothing when a payment notification reaches the refund endpoint', async () => {
    const started = await paidAtGateway();
    const signed = gateway.signTransactionNotification({ outTradeNo: started.outTradeNo });

    const result = await service.handleRefundNotify(racer(), signed);

    // No `out_refund_no`, so the refund domain ignores it.
    expect(result.status).toBe(200);
    expect((await orderRow(started.orderId)).status).toBe('pending_payment');
    expect(await flowRows('order_payment')).toEqual([]);
  });

  // Both webhooks write into one `payment_callbacks` table keyed by
  // `(mch_id, provider_notify_id)`. A webhook that inserted its row *before*
  // checking the event type would let a misrouted delivery burn the
  // notification id, and the genuine delivery that follows would be taken for a
  // WeChat retry and acknowledged without booking anything: money taken at the
  // gateway, an order still `pending_payment`, and the auto-cancel job on its
  // way.
  it('lets the genuine delivery book the payment after a misrouted copy of it', async () => {
    const started = await paidAtGateway();
    const signed = gateway.signTransactionNotification({ outTradeNo: started.outTradeNo });

    await service.handleRefundNotify(racer(), signed);

    const genuine = await handleTransactionNotify(racer(), signed);
    expect(genuine.status).toBe(200);
    expect((await orderRow(started.orderId)).status).toBe('paid');
  });

  it('answers a misroute 200 and records no callback row, in either direction', async () => {
    const order = await paidOrder();
    const before = (await callbackRows()).length;

    const transaction = gateway.signTransactionNotification({ outTradeNo: order.outTradeNo });
    expect((await service.handleRefundNotify(racer(), transaction)).status).toBe(200);

    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'SUCCESS');
    const refunded = gateway.signRefundNotification({ outRefundNo: refund.outRefundNo });
    expect((await handleTransactionNotify(racer(), refunded)).status).toBe(200);
    expect(await callbackRows()).toHaveLength(before);

    // And the refund's own delivery, arriving after its misrouted copy, settles it.
    expect((await service.handleRefundNotify(racer(), refunded)).status).toBe(200);
    expect((await refundRow(refund.id)).status).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// a notification that names another merchant
// ---------------------------------------------------------------------------

describe('a well-signed notification naming another merchant', () => {
  // `mchid` is read from the resource and compared with the configured
  // merchant. Logging a mismatch and settling anyway would write the foreign
  // merchant onto the capital flow. The AEAD key is the only other thing
  // binding the body to this shop; the merchant number is the second lock.
  it('never marks an order paid on a transaction another merchant collected', async () => {
    const started = await paidAtGateway();
    const signed = gateway.signTransactionNotification({
      outTradeNo: started.outTradeNo,
      resource: transactionResource(started.outTradeNo, { mchid: OTHER_MCH_ID }),
    });

    const result = await handleTransactionNotify(racer(), signed);

    expect(result.status).toBe(200);
    expect((await orderRow(started.orderId)).status).toBe('pending_payment');
    expect(await flowRows('order_payment')).toEqual([]);
  });

  it('never settles a refund on a notification from another merchant', async () => {
    const order = await paidOrder();
    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'SUCCESS');
    const signed = gateway.signRefundNotification({
      outRefundNo: refund.outRefundNo,
      resource: refundResource(refund.outRefundNo, { mchid: OTHER_MCH_ID }),
    });

    const result = await service.handleRefundNotify(racer(), signed);

    expect(result.status).toBe(200);
    expect((await refundRow(refund.id)).status).toBe('processing');
    expect((await orderRow(order.orderId)).refundedAmount).toBe('0.00');
  });

  it('records the merchant it was told on the callback row, so the mismatch is at least visible', async () => {
    const started = await paidAtGateway();
    const signed = gateway.signTransactionNotification({
      outTradeNo: started.outTradeNo,
      resource: transactionResource(started.outTradeNo, { mchid: OTHER_MCH_ID }),
    });

    await handleTransactionNotify(racer(), signed);

    const [row] = await callbackRows();
    expect(row!.mchId).toBe(OTHER_MCH_ID);
  });

  it('tells an operator, and neither books nor refunds the foreign payment', async () => {
    const started = await paidAtGateway();
    const signed = gateway.signTransactionNotification({
      outTradeNo: started.outTradeNo,
      resource: transactionResource(started.outTradeNo, { mchid: OTHER_MCH_ID }),
    });

    expect((await handleTransactionNotify(racer(), signed)).status).toBe(200);
    // A replay of the same delivery changes nothing and wakes nobody twice.
    expect((await handleTransactionNotify(racer(), signed)).status).toBe(200);

    const [callback] = await callbackRows();
    expect(callback!.result).toMatch(/^exception: merchant_mismatch/);
    const [attempt] = await harness.ctx.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, started.orderId));
    expect(attempt!.status).not.toBe('paid');
    // Not a payment exception: that row carries an automatic refund, and this
    // money is not ours to send back.
    expect(await harness.ctx.db.select().from(paymentExceptions)).toEqual([]);
    const told = await notificationRows(PAYMENT_NOTIFY_MISMATCH_EVENT);
    expect(told).toHaveLength(1);
    expect(told[0]!.scopeId).toBe(
      `${PAYMENT_NOTIFY_MISMATCH_EVENT}:payment_callback:${callback!.id}`,
    );
  });

  it('refuses a payment notification that names no merchant at all', async () => {
    const started = await paidAtGateway();
    const resource = transactionResource(started.outTradeNo);
    delete resource['mchid'];
    const signed = gateway.signTransactionNotification({
      outTradeNo: started.outTradeNo,
      resource,
    });

    expect((await handleTransactionNotify(racer(), signed)).status).toBe(200);
    expect((await orderRow(started.orderId)).status).toBe('pending_payment');
    expect((await callbackRows())[0]!.result).toMatch(/^exception: merchant_mismatch/);
  });

  it('leaves a refund from another merchant for an operator, on the row and in its log', async () => {
    const order = await paidOrder();
    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'SUCCESS');
    const signed = gateway.signRefundNotification({
      outRefundNo: refund.outRefundNo,
      resource: refundResource(refund.outRefundNo, { mchid: OTHER_MCH_ID }),
    });

    expect((await service.handleRefundNotify(racer(), signed)).status).toBe(200);

    const row = await refundRow(refund.id);
    expect(row.status).toBe('processing');
    expect(row.lastError).toContain(OTHER_MCH_ID);
    expect((await refundLogRows(refund.id)).some((log) => log.message?.includes('退款异常'))).toBe(
      true,
    );
    expect(await notificationRows(REFUND_EXCEPTION_EVENT)).toHaveLength(1);
    const callback = (await callbackRows()).find((entry) => entry.mchId === OTHER_MCH_ID);
    expect(callback!.result).toMatch(/^exception: merchant_mismatch/);
  });
});

// ---------------------------------------------------------------------------
// the amount a refund notification states
// ---------------------------------------------------------------------------

describe('the amount inside a refund notification', () => {
  it('can never change the amount booked: settlement uses the frozen amount', async () => {
    const order = await paidOrder();
    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'SUCCESS');
    // A signed body that claims WeChat gave back all 100.00, not the 50.00 we
    // sent. It is not booked at all — least of all as 100.00.
    const signed = gateway.signRefundNotification({
      outRefundNo: refund.outRefundNo,
      resource: refundResource(refund.outRefundNo, {
        amount: { total: 10000, refund: 10000, payer_total: 10000, payer_refund: 10000 },
      }),
    });

    await service.handleRefundNotify(racer(), signed);

    expect((await refundRow(refund.id)).refundedAmount).toBe('0.00');
    expect((await orderRow(order.orderId)).refundedAmount).toBe('0.00');

    // The matching answer books exactly the frozen amount.
    const matching = gateway.signRefundNotification({ outRefundNo: refund.outRefundNo });
    await service.handleRefundNotify(racer(), matching);
    const row = await refundRow(refund.id);
    expect(row.status).toBe('succeeded');
    expect(row.refundedAmount).toBe('50.00');
    expect((await orderRow(order.orderId)).refundedAmount).toBe('50.00');
  });

  // If the notified `amount.refund` were not read, a gateway that gave back one
  // fen against the 50.00 we asked for would be booked as a 50.00 refund — the
  // shopper owed 49.99 and every ledger saying they were paid. The payment
  // webhook refuses a disagreeing amount into an exception (GATEWAY-001); the
  // refund webhook should not be the softer of the two.
  it('does not book a refund whose notified amount disagrees with the frozen one', async () => {
    const order = await paidOrder();
    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'SUCCESS');
    const signed = gateway.signRefundNotification({
      outRefundNo: refund.outRefundNo,
      resource: refundResource(refund.outRefundNo, {
        amount: { total: 10000, refund: 1, payer_total: 10000, payer_refund: 1 },
      }),
    });

    const result = await service.handleRefundNotify(racer(), signed);

    expect(result.status).toBe(200);
    expect((await refundRow(refund.id)).status).not.toBe('succeeded');
    expect((await orderRow(order.orderId)).refundedAmount).toBe('0.00');
    expect(await flowRows('order_refund')).toEqual([]);
  });

  it('raises a disagreeing or missing amount to an operator', async () => {
    const order = await paidOrder();
    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'SUCCESS');
    const noAmount = refundResource(refund.outRefundNo);
    delete noAmount['amount'];
    const signed = gateway.signRefundNotification({
      outRefundNo: refund.outRefundNo,
      resource: noAmount,
    });

    expect((await service.handleRefundNotify(racer(), signed)).status).toBe(200);

    const row = await refundRow(refund.id);
    expect(row.status).toBe('processing');
    expect(row.lastError).toContain('网关未给出退款金额');
    const callback = (await callbackRows()).find((entry) => entry.kind === 'refund_success');
    expect(callback!.result).toMatch(/^exception: amount_mismatch/);
    expect(await notificationRows(REFUND_EXCEPTION_EVENT)).toHaveLength(1);
  });

  it('reads the amount on the query path too, and says so once however often the sweep asks', async () => {
    const order = await paidOrder();
    const refund = await processingRefund(order);
    gateway.markRefunded(refund.outRefundNo, 'SUCCESS');
    // WeChat's record of this refund says 0.01 went back, not 50.00.
    gateway.refunds.get(refund.outRefundNo)!.refundFen = 1;

    const first = await service.reconcileRefund(racer(), refund.id);
    const second = await service.reconcileRefund(racer(), refund.id);

    expect(first.status).toBe('unknown');
    expect(second.status).toBe('unknown');
    const row = await refundRow(refund.id);
    expect(row.status).toBe('processing');
    expect(row.lastError).toBe('网关退款金额 0.01 与退款单金额 50.00 不符');
    expect(row.lastErrorSummary).toBe(row.lastError);
    expect((await orderRow(order.orderId)).refundedAmount).toBe('0.00');
    expect(await flowRows('order_refund')).toEqual([]);
    expect(
      (await refundLogRows(refund.id)).filter((log) => log.message?.includes('退款异常')),
    ).toHaveLength(1);
    expect(await notificationRows(REFUND_EXCEPTION_EVENT)).toHaveLength(1);
  });
});
