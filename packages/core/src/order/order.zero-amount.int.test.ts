import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { productSkus, products } from '@shop/db/schema/catalog';
import { couponTemplates, userCoupons } from '@shop/db/schema/coupon';
import { orders } from '@shop/db/schema/order';
import { paymentAttempts } from '@shop/db/schema/payment';
import { userAddresses, users } from '@shop/db/schema/user';
import {
  createTestCtx,
  flushTestRedis,
  startFakeWechatGateway,
  type FakeWechatGateway,
  type TestCtx,
} from '@shop/testing';
import { registerCatalogDomain, stockAndSalesOf } from '../catalog';
import { resetEffectHandlers } from '../effects';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import * as order from './index';
import { orderStateMachine } from './order.state-machine';
import { installStockCommitHook } from './order.stock.hooks';
import { registerOrderStateMachine, resetOrderPorts } from './ports';
import { registerShippingFreightPort } from '../shipping';
import { wechatConfig } from '../wechat';
import { paymentConfig, registerPaymentDomain, startPayment } from '../payment';

/**
 * PAY-012: an order a coupon paid for in full.
 *
 * WeChat Pay cannot collect 0 and `payment_attempts_amount_positive` refuses the
 * row, so before this such an order sat in 待支付 and every 去支付 was a 500. It
 * is now paid the moment it is placed — no attempt, no gateway call — and the
 * cashier settles one placed before that the same way.
 */

let harness: TestCtx;
let gateway: FakeWechatGateway;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, platform: 'wechat-mini' });
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
  harness.queue.reset();
  resetEffectHandlers();
  gateway.calls.length = 0;

  resetOrderPorts();
  registerCatalogDomain();
  registerShippingFreightPort();
  registerOrderStateMachine(orderStateMachine);
  // The `onOrderPaid` hook that turns the reservation into a sale.
  installStockCommitHook();
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

const as = (userId: number): Ctx =>
  harness.as({ kind: 'user', id: userId, permissions: [], isSuper: false } satisfies Actor);

let sequence = 0;

/** A shopper with a ¥78.99 product in reach and, when asked, a coupon worth `couponAmount`. */
async function shopper(couponAmount: string | null) {
  sequence += 1;
  const n = sequence;
  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: `zero-${n}` })
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
      price: '78.99',
      stock: 10,
      freightMode: 'free',
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `ZERO-${n}`,
      specText: '默认',
      price: '78.99',
      stock: 10,
      isDefault: true,
    })
    .returning({ id: productSkus.id });

  let couponId: number | null = null;
  if (couponAmount !== null) {
    const [template] = await harness.ctx.db
      .insert(couponTemplates)
      .values({
        name: `券${n}`,
        status: 'active',
        claimMode: 'manual',
        discountAmount: couponAmount,
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
        sourceKind: 'admin_grant',
        title: `券${n}`,
        discountAmount: couponAmount,
        minSpend: '0.00',
        status: 'unused',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: new Date('2026-12-31T00:00:00.000Z'),
      })
      .returning({ id: userCoupons.id });
    couponId = wallet!.id;
  }

  const buy = () =>
    order.create(as(userId), {
      source: 'buy-now',
      cartItemIds: [],
      item: { skuId: String(sku!.id), quantity: 1 },
      kind: 'normal',
      ...(couponId === null ? {} : { userCouponId: String(couponId) }),
      idempotencyKey: `zero-${String(n).padStart(10, '0')}`,
    });
  return { userId, skuId: sku!.id, couponId, buy };
}

const orderRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .then((rows) => rows[0]!);

const attemptsOf = (orderId: number) =>
  harness.ctx.db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId));

describe('PAY-012 — an order a coupon paid for in full', () => {
  it('is paid when it is placed, with no attempt and no gateway call', async () => {
    const buyer = await shopper('100.00');

    const detail = await buyer.buy();
    const orderId = Number(detail.id);

    const row = await orderRow(orderId);
    expect(row.payableAmount).toBe('0.00');
    expect(row.status).toBe('paid');
    expect(row.paidAmount).toBe('0.00');
    expect(row.paidAt).not.toBeNull();
    expect(row.transactionNo).toBeNull();
    expect(await attemptsOf(orderId)).toEqual([]);
    expect(gateway.calls).toEqual([]);
    // Paid, so the stock is a sale now, and there is nothing left to auto-cancel
    // or to remind the buyer about.
    expect(await stockAndSalesOf(harness.ctx.db, buyer.skuId)).toEqual({ stock: 9, sales: 1 });
    expect(harness.queue.jobs.filter((job) => job.jobName === 'order.autoCancel')).toEqual([]);
    expect(harness.queue.jobs.filter((job) => job.jobName === 'order.remindUnpaid')).toEqual([]);
  });

  it('settles one still waiting at the cashier instead of failing the insert', async () => {
    // An order placed before checkout settled these: it is still 待支付 at ¥0.
    const buyer = await shopper(null);
    const orderId = Number((await buyer.buy()).id);
    await harness.ctx.db
      .update(orders)
      .set({ couponDiscount: '78.99', payableAmount: '0.00' })
      .where(eq(orders.id, orderId));

    const error = await startPayment(as(buyer.userId), {
      orderId,
      channel: 'wechat_mini',
      openid: 'oFakeOpenid',
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    // The cashier refetches on this and shows 订单已支付.
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('PAYMENT_ORDER_ALREADY_PAID');
    const row = await orderRow(orderId);
    expect(row.status).toBe('paid');
    expect(row.paidAmount).toBe('0.00');
    expect(await attemptsOf(orderId)).toEqual([]);
    expect(gateway.calls).toEqual([]);
  });

  it('still sends an order with money left to pay to the gateway', async () => {
    const buyer = await shopper('10.00');
    const orderId = Number((await buyer.buy()).id);
    expect((await orderRow(orderId)).status).toBe('pending_payment');

    const intent = await startPayment(as(buyer.userId), {
      orderId,
      channel: 'wechat_mini',
      openid: 'oFakeOpenid',
    });

    expect(intent.amount).toBe('68.99');
    expect(intent.jsapi).not.toBeNull();
  });
});
