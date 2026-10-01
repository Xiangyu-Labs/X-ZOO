import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { products, productSkus } from '@shop/db/schema/catalog';
import { orderItems, orders, type OrderItemSnapshot } from '@shop/db/schema/order';
import {
  capitalFlows,
  paymentAttempts,
  paymentCallbacks,
  paymentExceptions,
} from '@shop/db/schema/payment';
import { admins } from '@shop/db/schema/auth';
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
import { DomainError } from '../kernel/errors';
import * as order from '../order';
import { registerCatalogDomain } from '../catalog';
import { registerOrderStateMachine, resetOrderPorts } from '../order/ports';
import { wechatConfig } from '../wechat';
import { registerPaymentDomain } from './index';
import { paymentConfig } from './payment.config';
import { registerPaymentEffects } from './payment.effects';
import { reconcileStalePayments } from './payment.jobs';
import * as repo from './payment.repo';
import * as service from './payment.service';
import {
  adminExceptionDetail,
  adminListExceptions,
  adminRecheckException,
  adminRefundException,
} from './payment.admin';

/**
 * The payment races.
 *
 * Four of the seven mandatory payment race scenarios live here — duplicate
 * callback delivery, a callback racing an order cancel, a late callback
 * arriving after the gateway order was closed, and the reconciliation sweep
 * racing a callback — plus a statement-level race for each conditional update
 * they depend on.
 *
 * Two things make these real rather than decorative:
 *
 *  - `runConcurrently` releases every caller from one barrier, so they collide
 *    inside the same statement instead of running in sequence;
 *  - each caller gets its own `Ctx` from `forkTestCtx`, so they take different
 *    pooled connections. Sharing one would serialise them and every assertion
 *    below would pass for the wrong reason.
 *
 * The gateway is the fake from `@shop/testing`: real RSA signing, real AEAD,
 * and it refuses to close a transaction that has been paid, which is the whole
 * point of the cancel race. It is driven by the *same fixed clock* as the
 * context, because `verifyNotification` checks the signature timestamp against
 * `ctx.clock` and a real-time gateway would look hours stale.
 */

let harness: TestCtx;
let gateway: FakeWechatGateway;

const NOW = '2026-06-01T00:00:00.000Z';
/** Far enough ahead that a row written with the database's own `now()` is stale. */
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
  // The config cache outlives the truncate, and `ConfigService.set` writes only
  // the keys that *changed* — against a stale cache that is nothing at all, and
  // the drop it does afterwards then leaves the group genuinely empty.
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
  resetEffectHandlers();
  gateway.transactions.clear();
  gateway.refunds.clear();
  gateway.calls.length = 0;
  gateway.behaviour.refundBalanceFen = null;
  gateway.behaviour.refundStatus = 'PROCESSING';
  gateway.behaviour.signResponsesWithWrongKey = false;
  gateway.behaviour.failNext = null;
  gateway.behaviour.dropNext = false;
  // The cancel below is the order domain's real one, so it needs its state
  // machine and this domain registered as the `PaymentPort` — both halves of
  // it.
  resetOrderPorts();
  registerOrderStateMachine(order.orderStateMachine);
  registerCatalogDomain();
  registerPaymentDomain();
  await configure();
});

afterEach(() => {
  resetEffectHandlers();
});

// ---------------------------------------------------------------------------
// fixtures
//
// They are local rather than shared with the refund suite on purpose: a helper
// module would have to import `@shop/db/schema/*`, and only `*.repo.ts` and
// test files may do that.
// ---------------------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });

/** A caller with its own context, acting as this user. */
function racer(userId?: number): Ctx {
  return forkTestCtx(harness, userId === undefined ? {} : { actor: userActor(userId) });
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
    .values({ account: `pay-user-${n}` })
    .returning({ id: users.id });
  const [product] = await db
    .insert(products)
    .values({
      name: `测试商品 ${n}`,
      imageUrl: 'https://cdn.example.test/p.jpg',
      status: 'on_shelf',
      // `products_freight_source`: the default `template` mode needs a template
      // row, and freight is not what these tests are about.
      freightMode: 'free',
      price: amount,
    })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(productSkus)
    .values({ productId: product!.id, skuCode: `SKU${n}`, price: amount, stock: 100 })
    .returning({ id: productSkus.id });
  const [order] = await db
    .insert(orders)
    .values({
      orderNo: `SO${String(n).padStart(10, '0')}`,
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

  return {
    orderId: order!.id,
    orderNo: `SO${String(n).padStart(10, '0')}`,
    userId: user!.id,
    amount,
  };
}

/** An order with a live gateway transaction behind it, exactly as a shopper leaves it. */
async function startedPayment(amount = '99.00'): Promise<OrderFixture & { outTradeNo: string }> {
  const order = await makePendingOrder(amount);
  const intent = await service.startPayment(racer(order.userId), {
    orderId: order.orderId,
    channel: 'wechat_mini',
    openid: 'oFakeOpenid',
  });
  return { ...order, outTradeNo: intent.outTradeNo };
}

/** The same, with the shopper having actually paid at the gateway. */
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

/**
 * The order domain's real `cancelOrder`, in the three words this file's
 * assertions are written in.
 *
 * The races run against the code that ships, not a local re-implementation of
 * the two-call protocol, so a cancel that skipped the first call would fail
 * here. All this wrapper does is turn the two refusals — both `DomainError`s —
 * back into `paid` and `blocked`.
 */
async function cancelOrder(ctx: Ctx, orderId: number): Promise<'cancelled' | 'paid' | 'blocked'> {
  try {
    const outcome = await order.cancelOrder(ctx, {
      orderId,
      reason: 'user',
      message: '买家取消',
    });
    return outcome.cancelled ? 'cancelled' : 'blocked';
  } catch (error) {
    if (DomainError.is(error)) {
      if (error.code === 'ORDER_ALREADY_PAID') return 'paid';
      if (error.code === 'ORDER_PAYMENT_STATE_UNKNOWN') return 'blocked';
    }
    throw error;
  }
}

// --- readers ---------------------------------------------------------------

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
const flowRows = (kind: 'order_payment' | 'exception_refund' | 'order_refund') =>
  harness.ctx.db.select().from(capitalFlows).where(eq(capitalFlows.kind, kind));

// ---------------------------------------------------------------------------
// PAY-007 — the same notification, delivered many times
// ---------------------------------------------------------------------------

describe('PAY-007 — duplicate callback delivery', () => {
  it('books the money once however many times WeChat delivers the same notification', async () => {
    const paid = await paidAtGateway();
    // One envelope, one notify id: this is a genuine redelivery, not two events.
    const signed = gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo });

    const report = await runConcurrently(6, () => notify(signed), {
      isWinner: (result) => result.status === 200,
    });

    // Every delivery is acknowledged. A 500 here would make WeChat retry
    // forever against money we already booked.
    expect(report.winners).toBe(6);
    expect(report.rejected).toEqual([]);

    // Exactly one of everything that costs money or tells another domain.
    expect(await callbackRows()).toHaveLength(1);
    expect(await flowRows('order_payment')).toHaveLength(1);
    expect(await effectRows('order.paid')).toHaveLength(1);
    expect(await exceptionRows()).toEqual([]);

    const order = await orderRow(paid.orderId);
    expect(order.status).toBe('paid');
    expect(order.paidAmount).toBe(paid.amount);
    expect(order.transactionNo).not.toBeNull();

    const attempts = await attemptRows(paid.orderId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('paid');
  });

  it('is the callback insert that decides, not a prior read — the repo statement alone', async () => {
    const report = await runConcurrently(
      8,
      () => {
        const ctx = racer();
        return ctx.withTx((tx) =>
          repo.insertCallback(tx, {
            kind: 'transaction_success',
            mchId: gateway.keys.mchId,
            providerNotifyId: 'notify-1',
            outTradeNo: 'OT1',
            transactionId: 'TX1',
            signatureVerified: true,
            payload: {},
          }),
        );
      },
      // Without this, `null` would count as a loser only by luck of truthiness;
      // spelling it out is what the convention asks for.
      { isWinner: (row) => row !== null },
    );

    expect(report.winners).toBe(1);
    expect(report.losers).toBe(7);
    expect(await callbackRows()).toHaveLength(1);
  });

  it('marks the order paid exactly once — the conditional update alone', async () => {
    const order = await makePendingOrder();

    const report = await runConcurrently(
      8,
      (index) => {
        const ctx = racer();
        return ctx.withTx((tx) =>
          repo.markOrderPaid(tx, order.orderId, {
            paidAmount: order.amount,
            paidAt: ctx.clock.now(),
            transactionNo: `TX-${index}`,
          }),
        );
      },
      { isWinner: (result) => result.won },
    );

    expect(report.winners).toBe(1);
    expect(report.losers).toBe(7);
    expect((await orderRow(order.orderId)).status).toBe('paid');
  });

  it('treats a second notification for the same transaction as a replay', async () => {
    const paid = await paidAtGateway();
    // Two different notify ids, same transaction: both rows are recorded, but
    // only one of them may move money.
    const first = gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo });
    const second = gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo });

    const report = await runConcurrently(2, (index) => notify(index === 0 ? first : second), {
      isWinner: (result) => result.status === 200,
    });
    expect(report.winners).toBe(2);

    const callbacks = await callbackRows();
    expect(callbacks).toHaveLength(2);
    expect(callbacks.filter((row) => row.result === 'ignored: already paid')).toHaveLength(1);
    expect(await flowRows('order_payment')).toHaveLength(1);
    expect(await effectRows('order.paid')).toHaveLength(1);
    expect(await exceptionRows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// QUEUE-003 / QUEUE-004 — a callback racing the cancel
// ---------------------------------------------------------------------------

describe('QUEUE-003 — a callback racing an order cancel', () => {
  it('never cancels an order whose money arrived, whichever side gets there first', async () => {
    const paid = await paidAtGateway();
    const signed = gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo });

    const report = await runConcurrently<
      { cancel: 'cancelled' | 'paid' | 'blocked' } | { notify: number }
    >(2, (index) =>
      index === 0
        ? cancelOrder(racer(paid.userId), paid.orderId).then((state) => ({ cancel: state }))
        : notify(signed).then((result) => ({ notify: result.status })),
    );

    expect(report.rejected).toEqual([]);
    const cancelResult = report.fulfilled.find((value) => 'cancel' in value);
    // Whoever ran first, the cancel is refused: either the gateway told us the
    // order was already paid, or the callback had already booked it.
    expect(cancelResult).toBeDefined();
    expect(cancelResult).not.toEqual({ cancel: 'cancelled' });

    const order = await orderRow(paid.orderId);
    expect(order.status).toBe('paid');
    expect(order.cancelledAt).toBeNull();
    // Both paths run `settlePayment`; only one of them may book the money.
    expect(await flowRows('order_payment')).toHaveLength(1);
    expect(await effectRows('order.paid')).toHaveLength(1);
  });

  it('refuses to cancel while an attempt is merely unknown — nothing is released on silence', async () => {
    const started = await startedPayment();
    // The gateway drops the close request on the floor. "We do not know" is a
    // state, not a branch that picks closed.
    gateway.behaviour.dropNext = true;

    const state = await cancelOrder(racer(started.userId), started.orderId);

    expect(state).toBe('blocked');
    expect((await orderRow(started.orderId)).status).toBe('pending_payment');
    expect((await attemptRows(started.orderId))[0]!.status).toBe('unknown');
  });

  it('closes exactly once when two cancels arrive together', async () => {
    const started = await startedPayment();

    const report = await runConcurrently(
      4,
      () => cancelOrder(racer(started.userId), started.orderId),
      {
        isWinner: (state) => state === 'cancelled',
      },
    );

    expect(report.rejected).toEqual([]);
    expect(report.winners).toBe(1);
    const order = await orderRow(started.orderId);
    expect(order.status).toBe('cancelled');
    expect((await attemptRows(started.orderId))[0]!.status).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// 改价 against a payment the buyer already started
// ---------------------------------------------------------------------------

describe('改价 while the buyer holds a payment for the old amount', () => {
  async function operator(): Promise<Ctx> {
    sequence += 1;
    const [row] = await harness.ctx.db
      .insert(admins)
      .values({ account: `op-${sequence}`, passwordHash: 'x', name: `操作员${sequence}` })
      .returning({ id: admins.id });
    return harness.ctx.as({ kind: 'admin', id: row!.id, permissions: [], isSuper: true });
  }

  const reprice = async (orderId: number, operatorDiscount: string) =>
    order.orderConsole.adminAdjustPrice(
      await operator(),
      { id: String(orderId) },
      { operatorDiscount },
    );

  it('closes the old payment at the gateway, and the buyer then pays the new amount', async () => {
    const started = await startedPayment('99.00');

    const detail = await reprice(started.orderId, '9.00');
    expect(detail.payableAmount).toBe('90.00');
    expect(gateway.transactions.get(started.outTradeNo)?.tradeState).toBe('CLOSED');
    expect((await attemptRows(started.orderId))[0]!.status).toBe('closed');

    // A fresh tap starts a fresh attempt, for the new amount.
    const intent = await service.startPayment(racer(started.userId), {
      orderId: started.orderId,
      channel: 'wechat_mini',
      openid: 'oFakeOpenid',
    });
    expect(intent.outTradeNo).not.toBe(started.outTradeNo);
    const open = (await attemptRows(started.orderId)).find((a) => a.status !== 'closed');
    expect(open?.amount).toBe('90.00');
  });

  it('refuses, and books the payment, when the buyer paid the old amount while the form was open', async () => {
    const paid = await paidAtGateway('99.00');

    await expect(reprice(paid.orderId, '9.00')).rejects.toMatchObject({
      code: 'ORDER_PRICE_NOT_ADJUSTABLE',
    });
    const row = await orderRow(paid.orderId);
    expect(row.status).toBe('paid');
    expect(row.payableAmount).toBe('99.00');
    expect(row.paidAmount).toBe('99.00');
  });
});

// ---------------------------------------------------------------------------
// PAY-011 — money that arrives after the order is gone
// ---------------------------------------------------------------------------

describe('PAY-011 — a late callback after the payment was closed', () => {
  it('records one exception and one automatic refund, and leaves the order cancelled', async () => {
    const started = await startedPayment();
    expect(await cancelOrder(racer(started.userId), started.orderId)).toBe('cancelled');

    // The money lands anyway: WeChat accepted it before our close, and the
    // notification is only now getting through.
    gateway.setTradeState(started.outTradeNo, 'SUCCESS');
    const signed = gateway.signTransactionNotification({ outTradeNo: started.outTradeNo });

    const report = await runConcurrently(4, () => notify(signed), {
      isWinner: (result) => result.status === 200,
    });
    expect(report.winners).toBe(4);

    const exceptions = await exceptionRows();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.reason).toBe('cancelled_order_payment');
    expect(exceptions[0]!.status).toBe('open');
    expect(exceptions[0]!.paidAmount).toBe(started.amount);

    // The order is untouched and the money was never booked as a payment.
    const order = await orderRow(started.orderId);
    expect(order.status).toBe('cancelled');
    expect(order.paidAt).toBeNull();
    expect(await flowRows('order_payment')).toEqual([]);

    // Exactly one refund effect, however many deliveries produced it.
    expect(await effectRows('payment.exception.refund')).toHaveLength(1);
  });

  it('sends the money back once when the effect ledger runs', async () => {
    const started = await startedPayment();
    await cancelOrder(racer(started.userId), started.orderId);
    gateway.setTradeState(started.outTradeNo, 'SUCCESS');
    gateway.behaviour.refundStatus = 'SUCCESS';
    await notify(gateway.signTransactionNotification({ outTradeNo: started.outTradeNo }));

    registerPaymentEffects();
    // Two dispatchers on the same ledger: the claim is `FOR UPDATE SKIP LOCKED`,
    // so the second finds nothing rather than refunding a second time.
    const reports = await runConcurrently(2, () => drainEffects(racer(), { batchSize: 5 }));
    expect(reports.rejected).toEqual([]);
    expect(reports.fulfilled.reduce((sum, r) => sum + r.done, 0)).toBe(1);

    const exception = (await exceptionRows())[0]!;
    expect(exception.status).toBe('refunded');
    expect(exception.refundNo).toMatch(/^X\d+$/);
    expect(gateway.refunds.size).toBe(1);
    expect(await flowRows('exception_refund')).toHaveLength(1);
  });

  /**
   * WeChat's usual first answer to a refund is PROCESSING. The row then sits in
   * `refund_unknown`, and both ways the real answer can arrive — the operator's
   * 查询结果 and the refund callback — must be able to settle it.
   */
  async function refundLeftProcessing() {
    const started = await startedPayment();
    await cancelOrder(racer(started.userId), started.orderId);
    gateway.setTradeState(started.outTradeNo, 'SUCCESS');
    gateway.behaviour.refundStatus = 'PROCESSING';
    await notify(gateway.signTransactionNotification({ outTradeNo: started.outTradeNo }));
    const exception = (await exceptionRows())[0]!;
    await service.refundException(racer(), exception.id);
    const pending = (await exceptionRows())[0]!;
    expect(pending.status).toBe('refund_unknown');
    expect(await flowRows('exception_refund')).toEqual([]);
    return pending;
  }

  const handler = (): Ctx =>
    harness.ctx.as({
      kind: 'admin',
      id: 1,
      permissions: ['payment:exception:handle'],
      isSuper: false,
    });

  it('settles a refund left PROCESSING when the operator asks again', async () => {
    const pending = await refundLeftProcessing();
    gateway.markRefunded(pending.refundNo!, 'SUCCESS');

    const detail = await adminRecheckException(handler(), { id: String(pending.id) });
    expect(detail.status).toBe('refunded');
    expect(await flowRows('exception_refund')).toHaveLength(1);

    // Asking once more changes nothing and books nothing twice.
    await adminRecheckException(handler(), { id: String(pending.id) });
    expect(await flowRows('exception_refund')).toHaveLength(1);
  });

  it('settles a refund left PROCESSING when the refund callback arrives', async () => {
    const pending = await refundLeftProcessing();
    const outcome = await harness.ctx.withTx((tx) =>
      service.applyExceptionRefundNotification(tx, harness.ctx, {
        refundNo: pending.refundNo!,
        status: 'SUCCESS',
        gatewayRefundId: '50000abc',
      }),
    );
    expect(outcome).toBe(`exception ${pending.id}: refunded`);
    expect((await exceptionRows())[0]!.status).toBe('refunded');
    expect(await flowRows('exception_refund')).toHaveLength(1);
  });

  it('books no money going out while the gateway still says PROCESSING', async () => {
    const pending = await refundLeftProcessing();
    const detail = await adminRecheckException(handler(), { id: String(pending.id) });
    expect(detail.status).toBe('refund_unknown');
    expect(await flowRows('exception_refund')).toEqual([]);
  });

  it('lets the operator retry 退款 on an unknown result without refunding twice', async () => {
    const pending = await refundLeftProcessing();
    gateway.markRefunded(pending.refundNo!, 'SUCCESS');
    const detail = await adminRefundException(handler(), { id: String(pending.id) });
    // The same frozen refund number: the gateway answers for the refund it has.
    expect(gateway.refunds.size).toBe(1);
    expect(detail.refundNo).toBe(pending.refundNo);
    expect(detail.status).toBe('refunded');
    expect(await flowRows('exception_refund')).toHaveLength(1);
  });

  /**
   * AGENTS rule 5: 退款 has an inverse in the way a refusal is undone — the
   * merchant tops the balance up and presses 退款 again. The row must say why in
   * Chinese while it waits, forget that once it is paid, and pay once.
   */
  it('says in Chinese why a refused refund waits, and clears it when the retry pays', async () => {
    const started = await startedPayment();
    await cancelOrder(racer(started.userId), started.orderId);
    gateway.setTradeState(started.outTradeNo, 'SUCCESS');
    await notify(gateway.signTransactionNotification({ outTradeNo: started.outTradeNo }));
    const exception = (await exceptionRows())[0]!;
    const id = String(exception.id);
    // The row records who pressed 退款, so the operator has to exist.
    const [admin] = await harness.ctx.db
      .insert(admins)
      .values({ account: 'refund-op', passwordHash: 'x', name: '退款操作员' })
      .returning({ id: admins.id });
    const operator = harness.ctx.as({
      kind: 'admin',
      id: admin!.id,
      permissions: ['payment:exception:handle', 'payment:exception:read'],
      isSuper: false,
    });

    gateway.behaviour.refundBalanceFen = 100;
    const refused = await adminRefundException(operator, { id }).catch((error: unknown) => error);
    // What the toast shows: Chinese, with neither the gateway's code nor its message.
    expect(refused).toBeInstanceOf(DomainError);
    expect((refused as DomainError).message).toMatch(/余额/);
    expect((refused as DomainError).message).not.toMatch(/NOT_ENOUGH|[A-Za-z]{4,}/);

    const waiting = await adminExceptionDetail(operator, { id });
    expect(waiting.status).toBe('refund_failed');
    expect(waiting.lastErrorSummary).toMatch(/余额/);
    expect(waiting.lastErrorSummary).not.toMatch(/NOT_ENOUGH/);
    // The raw text is there for 技术详情, and only there.
    expect(waiting.lastError).toContain('NOT_ENOUGH');
    expect(await flowRows('exception_refund')).toEqual([]);

    // The listing carries the same words, so the column needs no second call.
    const listed = await adminListExceptions(operator, { page: 1, pageSize: 20 });
    expect(listed.items[0]!.lastErrorSummary).toBe(waiting.lastErrorSummary);

    gateway.behaviour.refundBalanceFen = null;
    gateway.behaviour.refundStatus = 'SUCCESS';
    const paid = await adminRefundException(operator, { id });
    expect(paid.status).toBe('refunded');
    expect(paid.refundNo).toBe(waiting.refundNo);
    expect(paid.lastErrorSummary).toBeNull();
    expect(paid.lastError).toBeNull();
    expect(gateway.refunds.size).toBe(1);
    expect(await flowRows('exception_refund')).toHaveLength(1);
  });

  it('refuses a caller without exception:handle', async () => {
    const pending = await refundLeftProcessing();
    const clerk = harness.ctx.as({ kind: 'admin', id: 1, permissions: [], isSuper: false });
    await expect(adminRecheckException(clerk, { id: String(pending.id) })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

// ---------------------------------------------------------------------------
// PAYC-002 — the reconciliation sweep racing a callback
// ---------------------------------------------------------------------------

describe('PAYC-002 — the reconciliation sweep racing a callback', () => {
  it('settles once when the sweep and the notification arrive together', async () => {
    const paid = await paidAtGateway();
    const signed = gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo });
    // `listStaleAttempts` compares `updated_at` against the clock, and the row
    // was written with the database's own `now()`; moving a year ahead is the
    // honest way to make it stale without sleeping.
    harness.clock.set(MUCH_LATER);

    const report = await runConcurrently(3, (index) =>
      index === 0
        ? reconcileStalePayments(racer(), { staleAfterMs: 60_000 }).then(() => 'sweep')
        : notify(signed).then(() => 'notify'),
    );

    expect(report.rejected).toEqual([]);
    expect((await orderRow(paid.orderId)).status).toBe('paid');
    expect(await flowRows('order_payment')).toHaveLength(1);
    expect(await effectRows('order.paid')).toHaveLength(1);
    expect(await exceptionRows()).toEqual([]);
    expect((await attemptRows(paid.orderId))[0]!.status).toBe('paid');
  });

  it('lets exactly one of many concurrent reconciliations book the payment', async () => {
    const paid = await paidAtGateway();

    const report = await runConcurrently(
      6,
      async () => {
        const attempt = (await attemptRows(paid.orderId))[0]!;
        return service.reconcileAttempt(racer(), attempt.id);
      },
      { isWinner: (state) => state === 'paid' },
    );

    expect(report.rejected).toEqual([]);
    // They all *report* paid — the question is whether they all *booked* it.
    expect(report.winners).toBe(6);
    expect(await flowRows('order_payment')).toHaveLength(1);
    expect(await effectRows('order.paid')).toHaveLength(1);
    expect(await exceptionRows()).toEqual([]);
  });

  it('never books a payment whose amount disagrees with the attempt', async () => {
    const paid = await paidAtGateway();
    const resource = {
      mchid: gateway.keys.mchId,
      out_trade_no: paid.outTradeNo,
      transaction_id: gateway.transactions.get(paid.outTradeNo)!.transactionId,
      trade_state: 'SUCCESS',
      success_time: NOW,
      payer: { openid: 'oFakeOpenid' },
      // One 分 short of what the attempt says it is collecting.
      amount: { total: 9899, payer_total: 9899, currency: 'CNY' },
    };
    const signed = gateway.signTransactionNotification({ outTradeNo: paid.outTradeNo, resource });

    const report = await runConcurrently(3, () => notify(signed), {
      isWinner: (result) => result.status === 200,
    });
    expect(report.winners).toBe(3);

    const exceptions = await exceptionRows();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.reason).toBe('amount_mismatch');
    expect((await orderRow(paid.orderId)).status).toBe('pending_payment');
    expect(await flowRows('order_payment')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PAYC-004 — two taps on 立即支付
// ---------------------------------------------------------------------------

describe('PAYC-004 — starting the same payment twice', () => {
  it('produces exactly one attempt and one gateway order', async () => {
    const order = await makePendingOrder();

    const report = await runConcurrently(6, () =>
      service.startPayment(racer(order.userId), {
        orderId: order.orderId,
        channel: 'wechat_mini',
        openid: 'oFakeOpenid',
      }),
    );

    expect(report.rejected).toEqual([]);
    const numbers = new Set(report.fulfilled.map((intent) => intent.outTradeNo));
    expect(numbers.size).toBe(1);
    expect(await attemptRows(order.orderId)).toHaveLength(1);
    expect(gateway.transactions.size).toBe(1);
  });

  it('refuses a replay that disagrees about the channel', async () => {
    const started = await startedPayment();
    await expect(
      service.startPayment(racer(started.userId), {
        orderId: started.orderId,
        channel: 'wechat_h5',
        returnUrl: 'https://shop.example.test/pay/done',
      }),
    ).rejects.toMatchObject({ name: 'DomainError', code: 'PAYMENT_ATTEMPT_CONFLICT' });
    expect(await attemptRows(started.orderId)).toHaveLength(1);
  });

  it('inserts at most one open attempt — the unique index alone', async () => {
    const order = await makePendingOrder();

    const report = await runConcurrently(
      8,
      (index) => {
        const ctx = racer();
        return ctx.withTx((tx) =>
          repo.insertAttempt(tx, {
            orderId: order.orderId,
            outTradeNo: `OT${index}${order.orderId}`,
            channel: 'wechat_mini',
            mchId: gateway.keys.mchId,
            appId: gateway.keys.appId,
            amount: order.amount,
            payerUserId: order.userId,
            context: { tradeType: 'JSAPI', notifyUrl: '/x', openid: 'oFakeOpenid' },
          }),
        );
      },
      { isWinner: (row) => row !== null },
    );

    expect(report.winners).toBe(1);
    expect(report.losers).toBe(7);
    const rows = await harness.ctx.db
      .select()
      .from(paymentAttempts)
      .where(
        and(eq(paymentAttempts.orderId, order.orderId), eq(paymentAttempts.status, 'creating')),
      );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TLS-006 — an answer we cannot verify is not an answer
// ---------------------------------------------------------------------------

/**
 * Not a race, but it shares this file's gateway fixture and it is the guard the
 * races above rest on.
 *
 * Failing *closed* on an unverifiable signature is right as far as it goes, but
 * without a word for "we do not know" the caller guesses, and a guess here
 * releases stock against money that may have arrived. Every path below must end
 * in `PAYMENT_STATE_UNKNOWN` or the attempt status `unknown`, and never in
 * `closed` or `paid`.
 */
describe('TLS-006 — an unverifiable gateway answer never becomes closed or paid', () => {
  it('refuses a query response signed with the wrong key', async () => {
    const started = await startedPayment();
    gateway.markPaid(started.outTradeNo);
    gateway.behaviour.signResponsesWithWrongKey = true;

    const { client } = await service.paymentRuntime(racer());
    await expect(client.queryTransaction(started.outTradeNo)).rejects.toMatchObject({
      name: 'DomainError',
      code: 'PAYMENT_STATE_UNKNOWN',
    });
  });

  /**
   * A successful close answers `204 No Content`. There is no body, so there is
   * no signature to verify and nothing an attacker could have rewritten — the
   * authentication of that answer is TLS, which is exactly why TLS-001 has no
   * toggle. Asserted here so that the *absence* of a signature check on this
   * one path is a decision on the record rather than an oversight.
   */
  it('accepts an empty 204 close, which carries no signature to verify', async () => {
    const started = await startedPayment();
    gateway.behaviour.signResponsesWithWrongKey = true;

    const { client } = await service.paymentRuntime(racer());
    await expect(client.closeTransaction(started.outTradeNo)).resolves.toBeUndefined();
  });

  it('refuses a close whose error body cannot be verified', async () => {
    const started = await startedPayment();
    gateway.behaviour.signResponsesWithWrongKey = true;
    gateway.behaviour.failNext = { status: 500, code: 'SYSTEM_ERROR', message: '系统繁忙' };

    const { client } = await service.paymentRuntime(racer());
    await expect(client.closeTransaction(started.outTradeNo)).rejects.toMatchObject({
      name: 'DomainError',
      code: 'PAYMENT_STATE_UNKNOWN',
    });
  });

  it('leaves the attempt unknown — not closed — when reconciliation cannot trust the answer', async () => {
    const started = await startedPayment();
    gateway.markPaid(started.outTradeNo);
    gateway.behaviour.signResponsesWithWrongKey = true;

    const [attempt] = await attemptRows(started.orderId);
    expect(await service.reconcileAttempt(racer(), attempt!.id)).toBe('unknown');

    const [after] = await attemptRows(started.orderId);
    expect(after!.status).toBe('unknown');
    expect((await orderRow(started.orderId)).status).toBe('pending_payment');
    expect(await flowRows('order_payment')).toEqual([]);
  });

  it('refuses to cancel an order whose close the gateway would not confirm', async () => {
    const started = await startedPayment();
    gateway.behaviour.failNext = { status: 500, code: 'SYSTEM_ERROR', message: '系统繁忙' };

    expect(await cancelOrder(racer(started.userId), started.orderId)).toBe('blocked');
    expect((await orderRow(started.orderId)).status).toBe('pending_payment');
  });

  it('treats a dropped connection as silence, not as a closed order', async () => {
    const started = await startedPayment();
    gateway.behaviour.dropNext = true;

    expect(await service.closeOrderPayments(racer(), started.orderId)).toBe('unknown');
    const [after] = await attemptRows(started.orderId);
    expect(after!.status).not.toBe('closed');
  });
});
