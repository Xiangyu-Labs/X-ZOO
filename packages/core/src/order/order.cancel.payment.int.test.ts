import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, products } from '@shop/db/schema/catalog';
import { couponTemplates, userCoupons } from '@shop/db/schema/coupon';
import { orderStatusLogs, orders } from '@shop/db/schema/order';
import { paymentAttempts } from '@shop/db/schema/payment';
import { userAddresses, users } from '@shop/db/schema/user';
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
import { registerCatalogDomain, stockAndSalesOf } from '../catalog';
import { registerShippingFreightPort } from '../shipping';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import {
  handleTransactionNotify,
  paymentConfig,
  registerPaymentDomain,
  startPayment,
} from '../payment';
import { wechatConfig } from '../wechat';
import * as order from './index';
import { orderStateMachine } from './order.state-machine';
import { registerOrderStateMachine, resetOrderPorts } from './ports';

/**
 * Cancelling an order with a live WeChat payment behind it.
 *
 * `order.int.test.ts` proves the cancel path against `fakePaymentPort`, which
 * answers whatever the test tells it to. That is the right tool for "what does
 * the cancel path do with each of the three answers", and the wrong one for the
 * protocol itself: a cancel path that made only *one* of the two calls would
 * pass every branch test, while the real port could only ever answer `unknown`.
 *
 * So everything here runs against the real payment domain, registered through
 * `registerPaymentDomain()`, talking to the fake WeChat gateway from
 * `@shop/testing`: real RSA signing, real AEAD, and a server that refuses to
 * close a transaction somebody has paid. The order under test is a real one
 * from checkout, so its stock is genuinely reserved and its coupon genuinely
 * spent — which is what "released" and "nothing released" mean below.
 *
 * The buyer being modelled is the ordinary one: they tapped 立即支付, the
 * WeChat sheet came up, and they closed it. Their attempt sits in `pending`,
 * and before this change every route into `cancelOrder` refused them.
 */

let harness: TestCtx;
let gateway: FakeWechatGateway;

const NOW = '2026-06-01T00:00:00.000Z';
/** Past `payWindowMinutes` (30), so the sweep considers the order expired. */
const AFTER_WINDOW = '2026-06-01T00:31:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, platform: 'h5' });
  // The gateway shares the context's clock: `verifyNotification` checks the
  // signature timestamp against `ctx.clock`, and a real-time gateway signing
  // for a context pinned to 2026 would look hours stale.
  gateway = await startFakeWechatGateway({ now: () => harness.clock.now().getTime() });
}, 180_000);

afterAll(async () => {
  await gateway?.close();
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  // `ConfigService.set` writes only what changed, and the cache outlives the
  // truncate — against a stale cache that is nothing at all.
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
  harness.queue.reset();
  resetEffectHandlers();
  gateway.transactions.clear();
  gateway.refunds.clear();
  gateway.calls.length = 0;
  gateway.behaviour.failNext = null;
  gateway.behaviour.dropNext = false;
  gateway.behaviour.signResponsesWithWrongKey = false;

  resetOrderPorts();
  registerCatalogDomain();
  registerShippingFreightPort();
  registerOrderStateMachine(orderStateMachine);
  // The real thing, not `fakePaymentPort`. This is the whole point of the file.
  registerPaymentDomain();

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
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let sequence = 0;

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });

const as = (userId: number): Ctx => harness.as(userActor(userId));

/** A caller with its own pooled connection, so a race collides instead of queueing. */
const racer = (userId: number): Ctx =>
  forkTestCtx(harness, { actor: userActor(userId), platform: 'h5' });

interface Shopper {
  userId: number;
  skuId: number;
  orderId: number;
  couponId: number | null;
  /** Units taken out of a stock of 10 when the order was created. */
  reserved: number;
}

/**
 * A real order from checkout: two units reserved out of ten, and a coupon moved
 * to `used` unless the test asks for one without.
 */
async function makeOrder(options: { coupon?: boolean } = {}): Promise<Shopper> {
  sequence += 1;
  const n = sequence;

  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: `cancel-pay-${n}` })
    .returning({ id: users.id });
  const userId = user!.id;

  await harness.ctx.db.insert(userAddresses).values({
    userId,
    receiverName: '张三',
    receiverPhone: '13800138000',
    provinceName: '浙江省',
    cityName: '杭州市',
    detail: '文三路 100 号',
    isDefault: true,
  });

  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${n}`,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      price: '60.00',
      stock: 10,
      freightMode: 'free',
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SKU-${n}`,
      specText: '默认',
      price: '60.00',
      stock: 10,
      isDefault: true,
    })
    .returning({ id: productSkus.id });

  const [cartRow] = await harness.ctx.db
    .insert(cartItems)
    .values({ userId, productId: product!.id, skuId: sku!.id, quantity: 2, isSelected: true })
    .returning({ id: cartItems.id });

  let couponId: number | null = null;
  if (options.coupon) {
    const [template] = await harness.ctx.db
      .insert(couponTemplates)
      .values({
        name: `券${n}`,
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
        title: `券${n}`,
        discountAmount: '10.00',
        minSpend: '0.00',
        status: 'unused',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: new Date('2026-12-31T00:00:00.000Z'),
      })
      .returning({ id: userCoupons.id });
    couponId = wallet!.id;
  }

  const detail = await order.create(as(userId), {
    source: 'cart',
    cartItemIds: [String(cartRow!.id)],
    kind: 'normal',
    ...(couponId === null ? {} : { userCouponId: String(couponId) }),
    idempotencyKey: `cp-${String(n).padStart(10, '0')}`,
  });
  harness.queue.reset();

  return { userId, skuId: sku!.id, orderId: Number(detail.id), couponId, reserved: 2 };
}

/**
 * The buyer opened the WeChat sheet. There is a gateway order and an open
 * attempt (`submitted`), and nothing has been paid — the state in which
 * `ensureNoOpenAttempts` alone can only ever answer `unknown`.
 */
async function openTheSheet(shopper: Shopper): Promise<string> {
  const intent = await startPayment(as(shopper.userId), {
    orderId: shopper.orderId,
    channel: 'wechat_mini',
    openid: 'oFakeOpenid',
  });
  const [attempt] = await attemptsOf(shopper.orderId);
  expect(attempt?.status).toBe('submitted');
  return intent.outTradeNo;
}

// --- readers ---------------------------------------------------------------

const orderRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .then((rows) => rows[0]!);

const attemptsOf = (orderId: number) =>
  harness.ctx.db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId));

const couponStatus = (id: number) =>
  harness.ctx.db
    .select()
    .from(userCoupons)
    .where(eq(userCoupons.id, id))
    .then((rows) => rows[0]!.status);

const stockOf = (skuId: number) => stockAndSalesOf(harness.ctx.db, skuId).then((row) => row.stock);

async function cancelError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `expected ${code}, the cancel succeeded instead`).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
}

/** Nothing came back: the stock is still reserved and the coupon still spent. */
async function expectNothingReleased(shopper: Shopper): Promise<void> {
  expect(await stockOf(shopper.skuId)).toBe(10 - shopper.reserved);
  if (shopper.couponId !== null) expect(await couponStatus(shopper.couponId)).toBe('used');
}

// ---------------------------------------------------------------------------
// (a) the buyer who backed out of the WeChat sheet
// ---------------------------------------------------------------------------

describe('cancelling an order whose buyer opened the WeChat sheet', () => {
  it('closes the attempt, cancels the order and gives back the stock and the coupon', async () => {
    const shopper = await makeOrder({ coupon: true });
    await openTheSheet(shopper);
    expect(await stockOf(shopper.skuId)).toBe(8);

    const detail = await order.cancel(
      as(shopper.userId),
      { id: String(shopper.orderId) },
      { reason: '不想要了' },
    );

    expect(detail.status).toBe('cancelled');
    // The gateway order is closed, so the money can no longer arrive — which is
    // the only thing that makes releasing the stock below safe.
    expect((await attemptsOf(shopper.orderId))[0]!.status).toBe('closed');
    expect(await stockOf(shopper.skuId)).toBe(10);
    expect(await couponStatus(shopper.couponId!)).toBe('unused');

    const logs = await harness.ctx.db.select().from(orderStatusLogs);
    expect(logs.map((row) => row.changeType)).toEqual(['created', 'cancelled']);
  });

  it('asks the gateway once, outside the transaction, and re-asks the database under the lock', async () => {
    const shopper = await makeOrder();
    const outTradeNo = await openTheSheet(shopper);

    await order.cancelOrder(as(shopper.userId), { orderId: shopper.orderId, reason: 'user' });

    // Exactly one close for this order's merchant number. The re-check under
    // the row lock is `ensureNoOpenAttempts`, which is database-only: if it
    // were talking to WeChat there would be two.
    const closes = gateway.calls.filter((call) => call.path.endsWith(`/${outTradeNo}/close`));
    expect(closes).toHaveLength(1);
  });

  it('needs no gateway call at all for a buyer who never reached the sheet', async () => {
    const shopper = await makeOrder();

    await order.cancelOrder(as(shopper.userId), { orderId: shopper.orderId, reason: 'user' });

    expect((await orderRow(shopper.orderId)).status).toBe('cancelled');
    // No attempt, nothing to close: `closeOrderPayments` answers from the
    // database. The common case must not become a WeChat round trip.
    expect(gateway.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) the expired-order sweep
// ---------------------------------------------------------------------------

describe('the expired-order sweep', () => {
  it('cancels an expired order whose buyer left an attempt open', async () => {
    const shopper = await makeOrder({ coupon: true });
    await openTheSheet(shopper);
    harness.clock.set(AFTER_WINDOW);

    expect(await order.sweepExpiredOrders(harness.ctx)).toEqual({
      scanned: 1,
      cancelled: 1,
      skipped: 0,
    });

    expect((await orderRow(shopper.orderId)).status).toBe('cancelled');
    expect((await attemptsOf(shopper.orderId))[0]!.status).toBe('closed');
    expect(await stockOf(shopper.skuId)).toBe(10);
    expect(await couponStatus(shopper.couponId!)).toBe('unused');
  });

  it('sweeps a batch of them, closing several gateway orders in one pass', async () => {
    const shoppers = [await makeOrder(), await makeOrder(), await makeOrder()];
    for (const shopper of shoppers) await openTheSheet(shopper);
    harness.clock.set(AFTER_WINDOW);

    expect(await order.sweepExpiredOrders(harness.ctx)).toEqual({
      scanned: 3,
      cancelled: 3,
      skipped: 0,
    });

    for (const shopper of shoppers) {
      expect((await orderRow(shopper.orderId)).status).toBe('cancelled');
      expect(await stockOf(shopper.skuId)).toBe(10);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) the money was already there
// ---------------------------------------------------------------------------

describe('when the gateway says the attempt was paid', () => {
  it('refuses the cancel with ORDER_ALREADY_PAID and releases nothing', async () => {
    const shopper = await makeOrder({ coupon: true });
    const outTradeNo = await openTheSheet(shopper);
    // The buyer paid while the app still thought the attempt was merely open.
    // Our close will be refused with ORDERPAID, and the truth comes back from
    // the query that follows it.
    gateway.markPaid(outTradeNo);

    await cancelError(
      order.cancel(as(shopper.userId), { id: String(shopper.orderId) }, {}),
      'ORDER_ALREADY_PAID',
    );

    await expectNothingReleased(shopper);
    const row = await orderRow(shopper.orderId);
    // Not merely "not cancelled": the close discovered the payment and booked
    // it, so the order is now paid and leaves through a refund, not a cancel.
    expect(row.status).toBe('paid');
    expect(row.cancelledAt).toBeNull();
    expect((await attemptsOf(shopper.orderId))[0]!.status).toBe('paid');
  });

  it('refuses the sweep the same way, and the order keeps its reservation', async () => {
    const shopper = await makeOrder();
    const outTradeNo = await openTheSheet(shopper);
    gateway.markPaid(outTradeNo);
    harness.clock.set(AFTER_WINDOW);

    expect(await order.sweepExpiredOrders(harness.ctx)).toEqual({
      scanned: 1,
      cancelled: 0,
      skipped: 1,
    });
    expect((await orderRow(shopper.orderId)).status).toBe('paid');
    await expectNothingReleased(shopper);
  });
});

// ---------------------------------------------------------------------------
// (d) the gateway will not answer
// ---------------------------------------------------------------------------

describe('when the gateway will not answer', () => {
  it('refuses with ORDER_PAYMENT_STATE_UNKNOWN and releases nothing', async () => {
    const shopper = await makeOrder({ coupon: true });
    await openTheSheet(shopper);
    // The close request is dropped on the floor. "We do not know" is a state,
    // not a branch that quietly picks `closed`.
    gateway.behaviour.dropNext = true;

    await cancelError(
      order.cancel(as(shopper.userId), { id: String(shopper.orderId) }, {}),
      'ORDER_PAYMENT_STATE_UNKNOWN',
    );

    await expectNothingReleased(shopper);
    expect((await orderRow(shopper.orderId)).status).toBe('pending_payment');
    expect((await attemptsOf(shopper.orderId))[0]!.status).toBe('unknown');
    expect(await harness.ctx.db.select().from(orderStatusLogs)).toHaveLength(1);
  });

  it('skips that order and sweeps the next one anyway', async () => {
    // One order with an attempt the gateway will not close, and one with no
    // attempt at all — whose close is answered from the database and so cannot
    // race for the dropped connection.
    const silent = await makeOrder();
    await openTheSheet(silent);
    const plain = await makeOrder();
    harness.clock.set(AFTER_WINDOW);
    gateway.behaviour.dropNext = true;

    expect(await order.sweepExpiredOrders(harness.ctx)).toEqual({
      scanned: 2,
      cancelled: 1,
      skipped: 1,
    });

    // The silent one keeps everything and waits for the next sweep.
    expect((await orderRow(silent.orderId)).status).toBe('pending_payment');
    await expectNothingReleased(silent);
    // The one behind it in the batch was not punished for that.
    expect((await orderRow(plain.orderId)).status).toBe('cancelled');
    expect(await stockOf(plain.skuId)).toBe(10);
  });

  it('cancels the skipped order on the next sweep, once the gateway is back', async () => {
    const shopper = await makeOrder();
    await openTheSheet(shopper);
    harness.clock.set(AFTER_WINDOW);
    gateway.behaviour.dropNext = true;
    expect((await order.sweepExpiredOrders(harness.ctx)).skipped).toBe(1);

    expect(await order.sweepExpiredOrders(harness.ctx)).toEqual({
      scanned: 1,
      cancelled: 1,
      skipped: 0,
    });
    expect((await orderRow(shopper.orderId)).status).toBe('cancelled');
    expect(await stockOf(shopper.skuId)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// (e) QUEUE-003 — the callback racing the cancel
// ---------------------------------------------------------------------------

describe('a payment callback racing the cancel on one order', () => {
  it('lets exactly one of them through, and releases the stock at most once', async () => {
    const shopper = await makeOrder({ coupon: true });
    const outTradeNo = await openTheSheet(shopper);

    type Side = { cancel: 'cancelled' | 'refused' } | { notify: number };

    const report = await runConcurrently<Side>(2, async (index) => {
      if (index === 0) {
        try {
          const outcome = await order.cancelOrder(racer(shopper.userId), {
            orderId: shopper.orderId,
            reason: 'user',
          });
          return { cancel: outcome.cancelled ? 'cancelled' : 'refused' };
        } catch (error) {
          // Both refusals are the protocol working, not a failure to handle.
          if (
            DomainError.is(error) &&
            (error.code === 'ORDER_ALREADY_PAID' || error.code === 'ORDER_PAYMENT_STATE_UNKNOWN')
          ) {
            return { cancel: 'refused' };
          }
          throw error;
        }
      }
      // The shopper paid after all, and WeChat is telling us so right now.
      gateway.markPaid(outTradeNo);
      const signed = gateway.signTransactionNotification({ outTradeNo });
      const result = await handleTransactionNotify(racer(shopper.userId), {
        headers: signed.headers,
        rawBody: signed.rawBody,
      });
      return { notify: result.status };
    });

    expect(report.rejected).toEqual([]);
    // WeChat is always acknowledged; a 500 would have it retry forever.
    expect(report.fulfilled.find((side) => 'notify' in side)).toEqual({ notify: 200 });

    const cancelSide = report.fulfilled.find((side) => 'cancel' in side)!;
    const row = await orderRow(shopper.orderId);

    if ('cancel' in cancelSide && cancelSide.cancel === 'cancelled') {
      // The cancel got there first. The money that landed afterwards is not the
      // order's any more — it is a payment exception, and the order stays
      // cancelled.
      expect(row.status).toBe('cancelled');
      expect(row.paidAt).toBeNull();
      expect(await stockOf(shopper.skuId)).toBe(10);
      expect(await couponStatus(shopper.couponId!)).toBe('unused');
    } else {
      // The money got there first, so nothing was released.
      expect(row.status).toBe('paid');
      expect(row.cancelledAt).toBeNull();
      await expectNothingReleased(shopper);
    }

    // Either way: released exactly once or not at all, never twice. Ten is the
    // stock we started with, so eleven would be a release on top of a release.
    expect(await stockOf(shopper.skuId)).toBeLessThanOrEqual(10);
    const logs = await harness.ctx.db.select().from(orderStatusLogs);
    expect(logs.filter((log) => log.toStatus === 'cancelled').length).toBeLessThanOrEqual(1);
  });

  it('cancels once when the shopper and the sweep arrive together on the same open attempt', async () => {
    const shopper = await makeOrder({ coupon: true });
    await openTheSheet(shopper);
    harness.clock.set(AFTER_WINDOW);

    const report = await runConcurrently(
      4,
      async (index) => {
        if (index === 0) {
          const swept = await order.sweepExpiredOrders(racer(shopper.userId));
          return swept.cancelled > 0;
        }
        const outcome = await order.cancelOrder(racer(shopper.userId), {
          orderId: shopper.orderId,
          reason: 'user',
        });
        return outcome.cancelled;
      },
      { isWinner: (won) => won },
    );

    expect(report.rejected).toEqual([]);
    expect(report.winners).toBe(1);
    expect((await orderRow(shopper.orderId)).status).toBe('cancelled');
    // The stock and the coupon come back exactly once, however many closers ran.
    expect(await stockOf(shopper.skuId)).toBe(10);
    expect(await couponStatus(shopper.couponId!)).toBe('unused');
    expect((await attemptsOf(shopper.orderId))[0]!.status).toBe('closed');
  });
});
