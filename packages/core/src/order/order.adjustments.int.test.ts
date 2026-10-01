import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cartItems } from '@shop/db/schema/cart';
import { products, productSkus } from '@shop/db/schema/catalog';
import { couponTemplates, userCoupons } from '@shop/db/schema/coupon';
import { orderItems } from '@shop/db/schema/order';
import { presaleActivities, presaleActivitySkus } from '@shop/db/schema/presale';
import { userAddresses, users } from '@shop/db/schema/user';
import type { OrderItem } from '@shop/contracts/order/schemas';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { registerAllDomains } from '../domains.gen';
import type { Actor, Ctx } from '../kernel/context';
import { Money } from '../kernel/money';
import { registerShippingFreightPort } from '../shipping';
import * as coupon from '../coupon';
import * as order from './index';
import { resetOrderPorts } from './ports';

/**
 * The order reads say what each checkout rule took off.
 *
 * An activity is priced as a `PricingContributor` adjustment that folds into
 * `couponDiscount` and the line's `discountAmount` alongside the coupon, and
 * the line keeps the catalogue `unitPrice`. Without a per-rule record, once a
 * coupon stacked on a 预售 the ¥10 activity and the ¥5 coupon would be one ¥15
 * nobody could split, and the 订单列表 would print ¥88 for a ¥78 预售.
 *
 * The create path keeps each rule's share of each line with the line
 * (`order_items.snapshot.adjustments`), and `orderItem` carries it on every
 * read — list, detail, and the create answer itself.
 *
 * Every domain is registered the way the web process does it: a presale
 * checkout needs the catalogue, stock, presale and coupon domains together.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';
/** The catalogue price. */
const LIST = '88.00';
/** The campaign price. */
const PRESALE = '78.00';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  resetOrderPorts();
  registerAllDomains();
  registerShippingFreightPort();
});

afterEach(() => {
  resetOrderPorts();
});

const asUser = (id: number): Ctx =>
  harness.as({ kind: 'user', id, permissions: [], isSuper: false } satisfies Actor);

let sequence = 0;

async function shopper(): Promise<number> {
  sequence += 1;
  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: `adj-${sequence}`, nickname: '小明' })
    .returning({ id: users.id });
  await harness.ctx.db.insert(userAddresses).values({
    userId: user!.id,
    receiverName: '张三',
    receiverPhone: '13800000000',
    provinceName: '广东省',
    cityName: '深圳市',
    detail: '某路 1 号',
    isDefault: true,
  });
  return user!.id;
}

async function sku(price: string): Promise<number> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      imageUrl: 'https://example.test/p.png',
      freightMode: 'free',
      status: 'on_shelf',
      price,
      stock: 1_000,
    })
    .returning({ id: products.id });
  const [row] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `ADJ-${sequence}`,
      specText: '默认',
      price,
      stock: 1_000,
    })
    .returning({ id: productSkus.id });
  return row!.id;
}

async function productOf(skuId: number): Promise<number> {
  const [row] = await harness.ctx.db
    .select({ productId: productSkus.productId })
    .from(productSkus)
    .where(eq(productSkus.id, skuId));
  return row!.productId;
}

/** A running 预售 at ¥78 on a ¥88 SKU. */
async function presaleOn(skuId: number): Promise<number> {
  const [activity] = await harness.ctx.db
    .insert(presaleActivities)
    .values({
      productId: await productOf(skuId),
      title: '春茶预售',
      status: 'active',
      paymentMode: 'full',
      price: PRESALE,
      stock: 100,
      perOrderQuantity: 5,
      startAt: new Date('2026-05-01T00:00:00.000Z'),
      endAt: new Date('2026-07-01T00:00:00.000Z'),
      shipAfterDays: 15,
    })
    .returning({ id: presaleActivities.id });
  await harness.ctx.db.insert(presaleActivitySkus).values({
    activityId: activity!.id,
    skuId,
    price: PRESALE,
    stock: 100,
    isEnabled: true,
  });
  return activity!.id;
}

/** A store-wide ¥`off` coupon already in the shopper's wallet. */
async function couponFor(userId: number, off: string, minSpend = '0.00'): Promise<number> {
  const [template] = await harness.ctx.db
    .insert(couponTemplates)
    .values({
      name: `减 ${off}`,
      status: 'active',
      claimMode: 'manual',
      discountAmount: off,
      minSpend,
      validityMode: 'days_after_claim',
      validDays: 30,
      isUnlimitedSupply: true,
      perUserLimit: 1,
    })
    .returning({ id: couponTemplates.id });
  const [held] = await harness.ctx.db
    .insert(userCoupons)
    .values({
      templateId: template!.id,
      userId,
      claimSlot: 1,
      sourceKind: 'claim',
      title: `减 ${off}`,
      discountAmount: off,
      minSpend,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: new Date('2026-12-31T00:00:00.000Z'),
    })
    .returning({ id: userCoupons.id });
  return held!.id;
}

/** `unitPrice` less the activity entries over `quantity` — what the storefront prints. */
function paidUnitPrice(item: OrderItem): string {
  const off = Money.sum(
    item.adjustments
      .filter((a) => a.source.endsWith(':activity-price'))
      .map((a) => Money.parse(a.amount)),
  ).abs();
  const paid = Money.parse(item.unitPrice).mul(item.quantity).sub(off);
  return Money.fromFen(paid.valueOfFen() / item.quantity).toString();
}

describe('a 预售 order with a stacked coupon', () => {
  it('separates the activity from the coupon, and the list and the detail agree', async () => {
    const userId = await shopper();
    const skuId = await sku(LIST);
    const activityId = await presaleOn(skuId);
    const userCouponId = await couponFor(userId, '5.00');

    const created = await order.create(asUser(userId), {
      source: 'buy-now',
      cartItemIds: [],
      item: { skuId: String(skuId), quantity: 1 },
      kind: 'presale',
      kindMeta: { activityId: String(activityId) },
      userCouponId: String(userCouponId),
      idempotencyKey: 'adj-presale-coupon-1',
    });

    // The amounts are what they were: the line keeps the catalogue price and
    // both discounts land in one `couponDiscount`.
    expect(created).toMatchObject({
      kind: 'presale',
      itemsAmount: '88.00',
      couponDiscount: '15.00',
      payableAmount: '73.00',
      userCouponId: String(userCouponId),
    });
    const [line] = created.items;
    expect(line).toMatchObject({
      unitPrice: '88.00',
      discountAmount: '15.00',
      totalAmount: '73.00',
    });

    // … and now the line says which is which, in the order they were applied.
    expect(line!.adjustments).toEqual([
      { source: 'presale:activity-price', label: expect.any(String), amount: '-10.00' },
      { source: 'coupon:discount', label: '优惠券抵扣', amount: '-5.00' },
    ]);
    expect(paidUnitPrice(line!)).toBe(PRESALE);

    const detail = await order.detail(asUser(userId), { id: created.id });
    const list = await order.list(asUser(userId), {
      tab: 'all',
      page: 1,
      pageSize: 20,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
    expect(detail.items).toEqual(created.items);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.items).toEqual(detail.items);
  });

  it('lists only the coupon on an ordinary order, split over its lines', async () => {
    const userId = await shopper();
    const [a, b] = [await sku('60.00'), await sku('40.00')];
    const userCouponId = await couponFor(userId, '10.00');
    const rows = await harness.ctx.db
      .insert(cartItems)
      .values(
        await Promise.all(
          [a, b].map(async (skuId) => ({
            userId,
            productId: await productOf(skuId),
            skuId,
            quantity: 1,
          })),
        ),
      )
      .returning({ id: cartItems.id });

    const created = await order.create(asUser(userId), {
      source: 'cart',
      cartItemIds: rows.map((row) => String(row.id)),
      kind: 'normal',
      userCouponId: String(userCouponId),
      idempotencyKey: 'adj-normal-coupon-1',
    });

    expect(created.couponDiscount).toBe('10.00');
    for (const item of created.items) {
      expect(item.adjustments.map((a) => a.source)).toEqual(['coupon:discount']);
      // Each line's entries add up to that line's share.
      expect(
        Money.sum(item.adjustments.map((a) => Money.parse(a.amount)))
          .abs()
          .toString(),
      ).toBe(item.discountAmount);
    }
    expect(
      Money.sum(
        created.items.flatMap((item) => item.adjustments.map((a) => Money.parse(a.amount))),
      ).toString(),
    ).toBe('-10.00');
  });

  it('lists nothing on an order with no discount, and nothing for a line written before', async () => {
    const userId = await shopper();
    const skuId = await sku('30.00');
    const created = await order.create(asUser(userId), {
      source: 'buy-now',
      cartItemIds: [],
      item: { skuId: String(skuId), quantity: 1 },
      kind: 'normal',
      idempotencyKey: 'adj-plain-1',
    });
    expect(created.items[0]!.adjustments).toEqual([]);

    // A line whose snapshot has no `adjustments` key.
    const [row] = await harness.ctx.db
      .select({ id: orderItems.id, snapshot: orderItems.snapshot })
      .from(orderItems);
    const { adjustments: _dropped, ...older } = row!.snapshot;
    void _dropped;
    await harness.ctx.db
      .update(orderItems)
      .set({ snapshot: older })
      .where(eq(orderItems.id, row!.id));
    const detail = await order.detail(asUser(userId), { id: created.id });
    expect(detail.items[0]!.adjustments).toEqual([]);
  });
});

describe('PRICE-005 — a coupon’s 使用门槛 is measured against the 拼团/预售 price', () => {
  it('refuses a ¥80 threshold on a ¥78 预售 of an ¥88 item, as the coupon picker says', async () => {
    const userId = await shopper();
    const skuId = await sku(LIST);
    const activityId = await presaleOn(skuId);
    const userCouponId = await couponFor(userId, '5.00', '80.00');
    const body = {
      source: 'buy-now' as const,
      cartItemIds: [],
      item: { skuId: String(skuId), quantity: 1 },
      kind: 'presale' as const,
      kindMeta: { activityId: String(activityId) },
    };

    // What the mini-program asks the picker with: the preview's lines after
    // the activity price.
    const base = await order.preview(asUser(userId), body);
    expect(base.lines[0]!.totalAmount).toBe(PRESALE);
    const picker = await coupon.listApplicable(asUser(userId), {
      lines: base.lines.map((line) => ({ productId: line.productId, amount: line.totalAmount })),
    });
    const listed = picker.items.find((row) => row.coupon.id === String(userCouponId));
    expect(listed).toMatchObject({ usable: false, reason: 'COUPON_MIN_SPEND_NOT_MET' });

    // … and the checkout agrees instead of taking ¥5 off the catalogue price.
    await expect(
      order.preview(asUser(userId), { ...body, userCouponId: String(userCouponId) }),
    ).rejects.toMatchObject({ code: 'COUPON_MIN_SPEND_NOT_MET' });
  });

  it('still applies a threshold the 预售 price meets', async () => {
    const userId = await shopper();
    const skuId = await sku(LIST);
    const activityId = await presaleOn(skuId);
    const userCouponId = await couponFor(userId, '5.00', '78.00');

    const priced = await order.preview(asUser(userId), {
      source: 'buy-now',
      cartItemIds: [],
      item: { skuId: String(skuId), quantity: 1 },
      kind: 'presale',
      kindMeta: { activityId: String(activityId) },
      userCouponId: String(userCouponId),
    });
    expect(priced.payableAmount).toBe('73.00');
  });
});
