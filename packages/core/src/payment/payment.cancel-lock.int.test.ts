import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { products, productSkus } from '@shop/db/schema/catalog';
import { orderItems, orders, type OrderItemSnapshot } from '@shop/db/schema/order';
import { paymentAttempts } from '@shop/db/schema/payment';
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
import type { Actor, Ctx } from '../kernel/context';
import * as order from '../order';
import { registerCatalogDomain } from '../catalog';
import { onOrderCancelled, registerOrderStateMachine, resetOrderPorts } from '../order/ports';
import { wechatConfig } from '../wechat';
import { registerPaymentDomain } from './index';
import { paymentConfig } from './payment.config';
import * as service from './payment.service';

/**
 * PAYC-001, the half that is a lock rather than a protocol.
 *
 * `cancelOrder` takes `SELECT … FOR UPDATE` on the order and re-asks the
 * payment domain, under that lock, whether an attempt is open. That re-check
 * is only worth something if `startPayment` takes **the same lock** before it
 * reads the order: otherwise a payment can read `pending_payment` while the
 * cancel is between its check and its commit, and open a gateway order on an
 * order that is cancelled a moment later — the "collectible payment on a
 * cancelled order" PAYC-001 forbids.
 *
 * No other test held the two sides at that instant, and MUT-001 showed it:
 * `lockOrderForPayment` without `.for('update')` passed every payment and
 * cancel test in the tree. This file holds them there deterministically, with
 * no sleeps: an `onOrderCancelled` hook runs *inside* the cancelling
 * transaction, after the transition and before the commit, and from there it
 * starts a payment on its own connection and waits until PostgreSQL reports
 * that payment blocked on a lock. Then it lets the cancel commit, and the
 * payment must see a cancelled order.
 */

let harness: TestCtx;
let gateway: FakeWechatGateway;

const NOW = '2026-06-01T00:00:00.000Z';

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
  gateway.transactions.clear();
  gateway.refunds.clear();
  gateway.calls.length = 0;
  gateway.behaviour.failNext = null;
  gateway.behaviour.dropNext = false;
  gateway.behaviour.signResponsesWithWrongKey = false;
  resetOrderPorts();
  registerOrderStateMachine(order.orderStateMachine);
  registerCatalogDomain();
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
  resetOrderPorts();
  resetEffectHandlers();
});

// --- fixtures ----------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });

/** A caller with its own pooled connection, so the two sides collide instead of queueing. */
const racer = (userId: number): Ctx => forkTestCtx(harness, { actor: userActor(userId) });

const snapshot = (): OrderItemSnapshot => ({
  productName: '测试商品',
  productImageUrl: 'https://cdn.example.test/p.jpg',
  productKind: 'physical',
  skuCode: 'SKU-LOCK',
  specText: '默认',
  specValues: {},
});

let sequence = 0;

async function makePendingOrder(amount = '99.00'): Promise<{ orderId: number; userId: number }> {
  sequence += 1;
  const n = sequence;
  const db = harness.ctx.db;
  const [user] = await db
    .insert(users)
    .values({ account: `lock-user-${n}` })
    .returning({ id: users.id });
  const [product] = await db
    .insert(products)
    .values({
      name: `锁测试商品 ${n}`,
      imageUrl: 'https://cdn.example.test/p.jpg',
      status: 'on_shelf',
      freightMode: 'free',
      price: amount,
    })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(productSkus)
    .values({ productId: product!.id, skuCode: `LOCK${n}`, price: amount, stock: 100 })
    .returning({ id: productSkus.id });
  const [row] = await db
    .insert(orders)
    .values({
      orderNo: `LK${String(n).padStart(10, '0')}`,
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
    orderId: row!.id,
    productId: product!.id,
    skuId: sku!.id,
    itemKey: 'L1',
    quantity: 1,
    unitPrice: amount,
    totalAmount: amount,
    snapshot: snapshot(),
  });
  return { orderId: row!.id, userId: user!.id };
}

/** Backends of this file's database that PostgreSQL reports as waiting on a lock. */
async function lockWaiters(): Promise<number> {
  const result = await harness.ctx.db.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return Number((result as unknown as { rows?: { n: number }[] }).rows?.[0]?.n ?? 0);
}

/**
 * Resolves once `pending` is blocked on a lock or has settled, whichever comes
 * first. Either is a state the assertions below can judge; neither within ten
 * seconds means the scenario never happened, which is a failure of its own.
 */
async function blockedOrSettled(pending: Promise<unknown>): Promise<'blocked' | 'settled'> {
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (settled) return 'settled';
    if ((await lockWaiters()) > 0) return 'blocked';
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the payment neither blocked on the order lock nor finished within 10s');
}

type Intent = Awaited<ReturnType<typeof service.startPayment>>;

const attemptRows = (orderId: number) =>
  harness.ctx.db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId));

const orderRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .then((rows) => rows[0]!);

// ---------------------------------------------------------------------------

describe('PAYC-001 — a payment started while a cancel holds the order lock', () => {
  it('waits for the cancel to commit, then refuses: no attempt, no gateway order', async () => {
    const placed = await makePendingOrder();

    let payment: Promise<Intent> | null = null;
    let whileLocked: 'blocked' | 'settled' | null = null;
    onOrderCancelled.register('test:start-a-payment-under-the-cancel-lock', async () => {
      // Inside the cancel: the order row is locked and already `cancelled` in
      // this transaction, and nothing is committed yet.
      payment = service.startPayment(racer(placed.userId), {
        orderId: placed.orderId,
        channel: 'wechat_mini',
        openid: 'oFakeOpenid',
      });
      whileLocked = await blockedOrSettled(payment);
    });

    const outcome = await order.cancelOrder(racer(placed.userId), {
      orderId: placed.orderId,
      reason: 'user',
    });
    expect(outcome.cancelled).toBe(true);

    // The payment could not get past the order row while the cancel held it.
    expect(whileLocked).toBe('blocked');
    await expect(payment).rejects.toMatchObject({
      name: 'DomainError',
      code: 'PAYMENT_ORDER_NOT_PAYABLE',
    });

    // And having waited, it saw the cancellation: nothing was opened anywhere.
    expect((await orderRow(placed.orderId)).status).toBe('cancelled');
    expect(await attemptRows(placed.orderId)).toEqual([]);
    expect(gateway.transactions.size).toBe(0);
    expect(
      gateway.calls.filter((call) => call.path.startsWith('/v3/pay/transactions/jsapi')),
    ).toEqual([]);
  });

  it('lets the payment through once the cancel has lost — the lock is a queue, not a refusal', async () => {
    const placed = await makePendingOrder();

    // The cancel aborts after taking the lock (a hook refusing, as group-buy
    // does when a team cannot release a seat). The payment that queued behind
    // it must then proceed against the order as it really is: still unpaid.
    let payment: Promise<Intent> | null = null;
    onOrderCancelled.register('test:start-a-payment-then-abort', async () => {
      payment = service.startPayment(racer(placed.userId), {
        orderId: placed.orderId,
        channel: 'wechat_mini',
        openid: 'oFakeOpenid',
      });
      expect(await blockedOrSettled(payment)).toBe('blocked');
      throw new Error('hook refuses: the cancel rolls back');
    });

    await expect(
      order.cancelOrder(racer(placed.userId), { orderId: placed.orderId, reason: 'user' }),
    ).rejects.toThrow('hook refuses');

    const intent = await payment!;
    expect(intent.outTradeNo).toBeTruthy();
    expect((await orderRow(placed.orderId)).status).toBe('pending_payment');
    const attempts = await attemptRows(placed.orderId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('submitted');
  });
});
