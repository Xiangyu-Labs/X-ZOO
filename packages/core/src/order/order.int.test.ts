import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '@shop/db';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, productVirtualCards, products } from '@shop/db/schema/catalog';
import { orderItems, orderStatusLogs, orders } from '@shop/db/schema/order';
import { couponTemplates, userCoupons } from '@shop/db/schema/coupon';
import { effects as effectsTable } from '@shop/db/schema/system';
import { userAddresses, users } from '@shop/db/schema/user';
import {
  createTestCtx,
  fakePaymentPort,
  forkTestCtx,
  runConcurrently,
  type TestCtx,
} from '@shop/testing';
import { registerCatalogDomain, reviewSubmit, runAutoReview, stockAndSalesOf } from '../catalog';
import { registerNotificationDomain } from '../notification';
import { registerShippingFreightPort } from '../shipping';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import * as order from './index';
import { orderConfig } from './order.config';
import { orderFulfilConfig } from './order.fulfil.config';
import { autoDeliver } from './order.fulfil.effects';
import { orderFacts } from './order.facts.repo';
import {
  registerOrderFacts,
  registerOrderStateMachine,
  registerPaymentPort,
  registerStockPort,
  resetOrderPorts,
  type StockLine,
} from './ports';
import { orderStateMachine } from './order.state-machine';

/**
 * Checkout, cancellation and the order list, against a real PostgreSQL.
 *
 * These are the behaviours a unit test cannot reach, because every one of them
 * is a property of a *transaction*: the cart rows disappear only if the order
 * committed, the stock comes back only if the cancellation won its conditional
 * update, and the idempotency claim is a UNIQUE index rather than a decision in
 * TypeScript. The races themselves live next door in
 * `order.concurrency.int.test.ts`.
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
  // The registry is module-level; a port left behind by one test would decide
  // the next one's cancellation.
  resetOrderPorts();
  registerCatalogDomain();
  registerShippingFreightPort();
  // `resetOrderPorts` clears every hook registry, so the notification domain
  // has to be reinstalled with the rest — and it has to be installed at all,
  // because `notify` drops an event nobody registered rather than failing the
  // order it belongs to. That is the right behaviour and it also means a test
  // that forgot this would pass while asserting nothing.
  registerNotificationDomain();
  registerOrderStateMachine(orderStateMachine);
});

/** The notification effects recorded so far, by key, sorted for comparison. */
async function notificationKeys(): Promise<string[]> {
  const rows = await harness.ctx.db
    .select({ scopeId: effectsTable.scopeId })
    .from(effectsTable)
    .where(eq(effectsTable.scope, 'notification'));
  return rows.map((row) => row.scopeId).sort();
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let sequence = 0;

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });

function as(userId: number): Ctx {
  return harness.as(userActor(userId));
}

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `buyer-${sequence}` })
    .returning({ id: users.id });
  return row!.id;
}

interface ProductOptions {
  kind?: 'physical' | 'virtual_card' | 'virtual_coupon' | 'virtual_manual';
  status?: 'draft' | 'on_shelf' | 'off_shelf';
  price?: string;
  stock?: number;
  freight?: string;
  minPurchaseQuantity?: number;
  purchaseLimit?: { mode: 'per_order' | 'lifetime'; quantity: number };
  customForm?: { key: string; label: string; type: 'text'; required: boolean }[];
}

async function makeProduct(
  options: ProductOptions = {},
): Promise<{ productId: number; skuId: number }> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      kind: options.kind ?? 'physical',
      status: options.status ?? 'on_shelf',
      imageUrl: `https://cdn.example.com/p/${sequence}.jpg`,
      unitName: '件',
      price: options.price ?? '60.00',
      stock: options.stock ?? 10,
      freightMode: options.freight ? 'fixed' : 'free',
      fixedFreight: options.freight ?? null,
      minPurchaseQuantity: options.minPurchaseQuantity ?? 1,
      purchaseLimitMode: options.purchaseLimit?.mode ?? 'none',
      purchaseLimitQuantity: options.purchaseLimit?.quantity ?? null,
      customForm: options.customForm ?? null,
    })
    .returning({ id: products.id });

  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SKU-${sequence}`,
      specText: '默认',
      price: options.price ?? '60.00',
      originalPrice: '88.00',
      cost: '30.00',
      stock: options.stock ?? 10,
      isDefault: true,
      weight: '1.000',
    })
    .returning({ id: productSkus.id });

  return { productId: product!.id, skuId: sku!.id };
}

async function makeAddress(userId: number): Promise<number> {
  const [row] = await harness.ctx.db
    .insert(userAddresses)
    .values({
      userId,
      receiverName: '张三',
      receiverPhone: '13800138000',
      provinceName: '浙江省',
      cityName: '杭州市',
      districtName: '西湖区',
      detail: '文三路 100 号',
      postCode: '310012',
      isDefault: true,
    })
    .returning({ id: userAddresses.id });
  return row!.id;
}

async function addToCart(
  userId: number,
  line: { productId: number; skuId: number },
  quantity = 1,
): Promise<number> {
  const [row] = await harness.ctx.db
    .insert(cartItems)
    .values({ userId, productId: line.productId, skuId: line.skuId, quantity, isSelected: true })
    .returning({ id: cartItems.id });
  return row!.id;
}

async function makeCoupon(
  userId: number,
  amounts: { discount: string; minSpend: string },
): Promise<number> {
  sequence += 1;
  const [template] = await harness.ctx.db
    .insert(couponTemplates)
    .values({
      name: `券${sequence}`,
      status: 'active',
      claimMode: 'manual',
      discountAmount: amounts.discount,
      minSpend: amounts.minSpend,
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
      title: `券${sequence}`,
      discountAmount: amounts.discount,
      minSpend: amounts.minSpend,
      status: 'unused',
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: new Date('2026-12-31T00:00:00.000Z'),
    })
    .returning({ id: userCoupons.id });
  return wallet!.id;
}

const idempotencyKey = () => `ck-${(sequence += 1).toString().padStart(10, '0')}`;

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<DomainError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `expected ${code}, got success`).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  return error as DomainError;
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

describe('checkout preview', () => {
  it('prices the ticked cart rows with freight and a coupon', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ price: '60.00', freight: '8.00' });
    await addToCart(userId, item, 2);
    await makeAddress(userId);
    const couponId = await makeCoupon(userId, { discount: '10.00', minSpend: '100.00' });

    const preview = await order.preview(as(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      userCouponId: String(couponId),
    });

    expect(preview.itemsAmount).toBe('120.00');
    // Fixed postage is per unit: `postage × quantity`.
    expect(preview.freightAmount).toBe('16.00');
    expect(preview.couponDiscount).toBe('10.00');
    expect(preview.payableAmount).toBe('126.00');
    expect(preview.lines[0]?.discountAmount).toBe('10.00');
    expect(preview.lines[0]?.totalAmount).toBe('110.00');
    expect(preview.receiver?.name).toBe('张三');
    expect(preview.addressRequired).toBe(true);
    expect(preview.adjustments.map((a) => a.amount)).toEqual(['-10.00']);
  });

  it('writes nothing — the cart and the coupon are untouched', async () => {
    const userId = await makeUser();
    const item = await makeProduct();
    await addToCart(userId, item, 1);
    const couponId = await makeCoupon(userId, { discount: '5.00', minSpend: '0.00' });

    await order.preview(as(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      userCouponId: String(couponId),
    });

    const [wallet] = await harness.ctx.db
      .select()
      .from(userCoupons)
      .where(eq(userCoupons.id, couponId));
    expect(wallet?.status).toBe('unused');
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(1);
  });

  it('prices 立即购买 without touching the cart', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ price: '25.00' });

    const preview = await order.preview(as(userId), {
      source: 'buy-now',
      cartItemIds: [],
      item: { skuId: String(item.skuId), quantity: 3 },
      addressId: null,
      kind: 'normal',
    });

    expect(preview.itemsAmount).toBe('75.00');
    expect(preview.lines[0]?.cartItemId).toBeNull();
    expect(preview.receiver).toBeNull();
    // No address, so freight cannot be worked out and is quoted as zero.
    expect(preview.freightAmount).toBe('0.00');
  });

  it('quotes zero freight while no address is chosen yet, and asks for one (FREIGHT-006)', async () => {
    // The cart preview before an address exists. The product charges postage,
    // so a zero here is the "no address yet" rule, not a free product. It is
    // checkout's rule, not the freight port's: an address that exists but
    // carries no known division is priced at the template's fallback region so
    // "nowhere yet" has to stop before the port is asked.
    const userId = await makeUser();
    const item = await makeProduct({ price: '60.00', freight: '8.00' });
    await addToCart(userId, item, 2);

    const preview = await order.preview(as(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
    });

    expect(preview.receiver).toBeNull();
    expect(preview.freightAmount).toBe('0.00');
    expect(preview.addressRequired).toBe(true);
    expect(preview.payableAmount).toBe('120.00');
  });

  it('refuses an off-shelf line instead of quietly dropping it', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ status: 'off_shelf' });
    await addToCart(userId, item, 1);

    const error = await expectDomainError(
      order.preview(as(userId), { source: 'cart', cartItemIds: [], kind: 'normal' }),
      'ORDER_ITEM_UNAVAILABLE',
    );
    expect(error.details).toEqual({ skuIds: [String(item.skuId)] });
  });

  it('refuses more than one card key per line', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ kind: 'virtual_card' });
    await addToCart(userId, item, 2);

    await expectDomainError(
      order.preview(as(userId), { source: 'cart', cartItemIds: [], kind: 'normal' }),
      'ORDER_VIRTUAL_CARD_QUANTITY',
    );
  });

  /**
   * The other door in. 立即购买 never touches the cart, so the cart's own
   * refusal does not cover it; the cap has to sit in `assertSellable`, where
   * both sources meet.
   */
  it('refuses more than one card key on 立即购买 too', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ kind: 'virtual_card' });

    const body = {
      source: 'buy-now' as const,
      cartItemIds: [],
      item: { skuId: String(item.skuId), quantity: 2 },
      addressId: null,
      kind: 'normal' as const,
    };
    await expectDomainError(order.preview(as(userId), body), 'ORDER_VIRTUAL_CARD_QUANTITY');
    await expectDomainError(
      order.create(as(userId), { ...body, idempotencyKey: idempotencyKey() }),
      'ORDER_VIRTUAL_CARD_QUANTITY',
    );
    // Refused at the door: no order, and the stock was never touched.
    expect(await harness.ctx.db.select().from(orders)).toHaveLength(0);
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(10);
  });

  /**
   * The other side of the one-card cap: it is a cap, not a ban. One card goes
   * through checkout and fulfilment's `autoDeliver` hands over exactly one key
   * — which is the whole reason the cap exists, since
   * `product_virtual_cards_order_item_uq` would let a line of two claim one
   * card and silently lose the other.
   */
  it('lets a single card key through checkout, and fulfilment delivers exactly one', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ kind: 'virtual_card' });
    await harness.ctx.db.insert(productVirtualCards).values([
      { productId: item.productId, skuId: item.skuId, cardKey: 'KEY-1', cardNo: 'NO-1' },
      { productId: item.productId, skuId: item.skuId, cardKey: 'KEY-2', cardNo: 'NO-2' },
    ]);
    const cartItemId = await addToCart(userId, item, 1);

    const detail = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      idempotencyKey: idempotencyKey(),
    });
    const orderId = Number(detail.id);
    expect(detail.items[0]?.quantity).toBe(1);

    // What the payment domain does when the money lands.
    await harness.ctx.db
      .update(orders)
      .set({ status: 'paid', paidAt: harness.clock.now(), paidAmount: '60.00' })
      .where(eq(orders.id, orderId));

    const outcome = await autoDeliver(harness.ctx, orderId);
    expect(outcome.delivered).toBe(true);
    expect(outcome.shortOfCards).toEqual([]);

    const claimed = await harness.ctx.db
      .select()
      .from(productVirtualCards)
      .where(eq(productVirtualCards.state, 'claimed'));
    // One line, one card. The second key is still on the shelf.
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.claimedByUserId).toBe(userId);
  });

  it('refuses an empty selection', async () => {
    const userId = await makeUser();
    await expectDomainError(
      order.preview(as(userId), { source: 'cart', cartItemIds: [], kind: 'normal' }),
      'ORDER_EMPTY',
    );
  });

  it('refuses somebody else’s address with the same code as an unknown one', async () => {
    const userId = await makeUser();
    const stranger = await makeUser();
    const addressId = await makeAddress(stranger);
    const item = await makeProduct();
    await addToCart(userId, item, 1);

    await expectDomainError(
      order.preview(as(userId), {
        source: 'cart',
        cartItemIds: [],
        kind: 'normal',
        addressId: String(addressId),
      }),
      'ORDER_ADDRESS_NOT_FOUND',
    );
  });

  it('counts a lifetime limit against what was already bought', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ purchaseLimit: { mode: 'lifetime', quantity: 2 } });
    const cartItemId = await addToCart(userId, item, 2);
    await makeAddress(userId);

    // First two are fine.
    await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      idempotencyKey: idempotencyKey(),
    });

    await addToCart(userId, item, 1);
    await expectDomainError(
      order.preview(as(userId), { source: 'cart', cartItemIds: [], kind: 'normal' }),
      'ORDER_PURCHASE_LIMIT_REACHED',
    );
  });

  it('CAT-014 — counts a lifetime limit the way the cart and the product page do: unpaid in, refunded out', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ purchaseLimit: { mode: 'lifetime', quantity: 2 } });
    await addToCart(userId, item, 2);
    await makeAddress(userId);
    const placed = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      idempotencyKey: idempotencyKey(),
    });

    // Unpaid, it already holds the allowance, for checkout and the port alike.
    const facts = () =>
      harness.ctx.withTx((tx) =>
        orderFacts.purchasedQuantity(tx, { userId, productId: item.productId }),
      );
    expect(await facts()).toBe(2);

    // Both units sent back: the allowance is free again, everywhere.
    await harness.ctx.db
      .update(orderItems)
      .set({ refundedQuantity: 2 })
      .where(eq(orderItems.orderId, Number(placed.id)));
    expect(await facts()).toBe(0);
    await addToCart(userId, item, 2);
    await expect(
      order.preview(as(userId), { source: 'cart', cartItemIds: [], kind: 'normal' }),
    ).resolves.toMatchObject({ totalQuantity: 2 });
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('order creation', () => {
  it('creates the order, takes the stock, empties the cart and schedules the cancel', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ price: '60.00', stock: 10, freight: '8.00' });
    const cartItemId = await addToCart(userId, item, 2);
    await makeAddress(userId);
    const couponId = await makeCoupon(userId, { discount: '10.00', minSpend: '100.00' });

    const detail = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      userCouponId: String(couponId),
      idempotencyKey: idempotencyKey(),
      buyerRemark: '请在工作日送达',
      expectedPayableAmount: '126.00',
    });

    expect(detail.status).toBe('pending_payment');
    expect(detail.payableAmount).toBe('126.00');
    expect(detail.couponDiscount).toBe('10.00');
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]?.discountAmount).toBe('10.00');
    expect(detail.receiver.name).toBe('张三');
    expect(detail.buyerRemark).toBe('请在工作日送达');
    expect(detail.payExpiresAt).toBe('2026-06-01T00:30:00.000Z');

    expect(await stockAndSalesOf(harness.ctx.db, item.skuId)).toEqual({ stock: 8, sales: 0 });
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(0);

    const [wallet] = await harness.ctx.db
      .select()
      .from(userCoupons)
      .where(eq(userCoupons.id, couponId));
    expect(wallet?.status).toBe('used');

    const logs = await harness.ctx.db.select().from(orderStatusLogs);
    expect(logs.map((row) => row.changeType)).toEqual(['created']);

    // The 30-minute window, and the 未付款提醒 ten minutes before it closes.
    expect(harness.queue.jobs).toEqual([
      {
        jobName: 'order.autoCancel',
        payload: { orderId: detail.id },
        options: { delay: 30 * 60_000, dedupeKey: `order-auto-cancel:${detail.id}` },
      },
      {
        jobName: 'order.remindUnpaid',
        payload: { orderId: detail.id },
        options: { delay: 20 * 60_000, dedupeKey: `order-unpaid-reminder:${detail.id}` },
      },
    ]);
  });

  it('per-line discount shares add back up to the order total', async () => {
    const userId = await makeUser();
    const a = await makeProduct({ price: '33.33' });
    const b = await makeProduct({ price: '33.33' });
    const c = await makeProduct({ price: '33.34' });
    for (const item of [a, b, c]) await addToCart(userId, item, 1);
    await makeAddress(userId);
    const couponId = await makeCoupon(userId, { discount: '10.00', minSpend: '0.00' });

    const detail = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      userCouponId: String(couponId),
      idempotencyKey: idempotencyKey(),
    });

    const shares = detail.items.map((line) => Number(line.discountAmount));
    expect(shares.reduce((sum, value) => sum + value, 0).toFixed(2)).toBe('10.00');
    expect(detail.couponDiscount).toBe('10.00');
  });

  it('returns the first order when the same idempotency key comes back', async () => {
    const userId = await makeUser();
    const item = await makeProduct();
    const cartItemId = await addToCart(userId, item, 1);
    await makeAddress(userId);
    const key = idempotencyKey();

    const first = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      idempotencyKey: key,
    });
    const second = await order.create(as(userId), {
      source: 'buy-now',
      cartItemIds: [],
      item: { skuId: String(item.skuId), quantity: 9 },
      kind: 'normal',
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    expect(await harness.ctx.db.select().from(orders)).toHaveLength(1);
    // The replay must not take a second bite of the stock either.
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(9);
  });

  it('refuses when the shopper was shown a different price', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ price: '60.00' });
    const cartItemId = await addToCart(userId, item, 1);
    await makeAddress(userId);

    const error = await expectDomainError(
      order.create(as(userId), {
        source: 'cart',
        cartItemIds: [String(cartItemId)],
        kind: 'normal',
        idempotencyKey: idempotencyKey(),
        expectedPayableAmount: '1.00',
      }),
      'ORDER_PRICE_CHANGED',
    );
    expect(error.details).toEqual({ expected: '1.00', actual: '60.00' });
    expect(await harness.ctx.db.select().from(orders)).toHaveLength(0);
    // The rolled-back claim leaves the key usable again.
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(10);
  });

  it('refuses physical goods with no address on file', async () => {
    const userId = await makeUser();
    const item = await makeProduct();
    const cartItemId = await addToCart(userId, item, 1);

    await expectDomainError(
      order.create(as(userId), {
        source: 'cart',
        cartItemIds: [String(cartItemId)],
        kind: 'normal',
        idempotencyKey: idempotencyKey(),
      }),
      'ORDER_ADDRESS_REQUIRED',
    );
  });

  it('lets a virtual product through without an address', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ kind: 'virtual_coupon' });
    const cartItemId = await addToCart(userId, item, 1);

    const detail = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      idempotencyKey: idempotencyKey(),
    });
    expect(detail.status).toBe('pending_payment');
    expect(detail.receiver.name).toBe('');
  });

  it('refuses an unanswered required custom form field', async () => {
    const userId = await makeUser();
    const item = await makeProduct({
      customForm: [{ key: 'engraving', label: '刻字', type: 'text', required: true }],
    });
    const cartItemId = await addToCart(userId, item, 1);
    await makeAddress(userId);

    const error = await expectDomainError(
      order.create(as(userId), {
        source: 'cart',
        cartItemIds: [String(cartItemId)],
        kind: 'normal',
        idempotencyKey: idempotencyKey(),
      }),
      'ORDER_CUSTOM_FORM_INCOMPLETE',
    );
    expect(error.details).toEqual({ fields: ['engraving'] });
  });

  it('refuses when the stock ran out between the preview and the submit', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ stock: 1 });
    const cartItemId = await addToCart(userId, item, 1);
    await makeAddress(userId);

    // Somebody else took the last unit after the shopper opened 确认订单.
    await harness.ctx.db
      .update(productSkus)
      .set({ stock: 0 })
      .where(eq(productSkus.id, item.skuId));

    await expectDomainError(
      order.create(as(userId), {
        source: 'cart',
        cartItemIds: [String(cartItemId)],
        kind: 'normal',
        idempotencyKey: idempotencyKey(),
      }),
      'ORDER_OUT_OF_STOCK',
    );
    expect(await harness.ctx.db.select().from(orders)).toHaveLength(0);
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(1);
  });

  it('refuses an order kind whose handler has not shipped', async () => {
    const userId = await makeUser();
    const item = await makeProduct();
    const cartItemId = await addToCart(userId, item, 1);
    await makeAddress(userId);

    await expectDomainError(
      order.create(as(userId), {
        source: 'cart',
        cartItemIds: [String(cartItemId)],
        kind: 'groupbuy',
        kindMeta: { activityId: '1' },
        idempotencyKey: idempotencyKey(),
      }),
      'VALIDATION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// the notifications checkout owes
// ---------------------------------------------------------------------------

describe('order-created notifications', () => {
  it('records the buyer’s and the admins’ notification in the checkout transaction', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ price: '60.00', stock: 10, freight: '0.00' });
    const cartItemId = await addToCart(userId, item, 2);
    await makeAddress(userId);

    const detail = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      idempotencyKey: idempotencyKey(),
    });
    const orderId = Number(detail.id);

    // One row per event, keyed on the order, still pending: `notify` records
    // and the dispatcher sends. Nothing was asked of WeChat inside the
    // checkout transaction.
    expect(await notificationKeys()).toEqual([
      `admin_order_created:order:${orderId}`,
      `order_created:order:${orderId}`,
    ]);

    const [row] = await harness.ctx.db
      .select()
      .from(effectsTable)
      .where(eq(effectsTable.scopeId, `order_created:order:${orderId}`));
    expect(row).toMatchObject({ scope: 'notification', status: 'pending' });
    expect(row?.payload).toMatchObject({
      event: 'order_created',
      userId,
      data: { orderNo: detail.orderNo, amount: detail.payableAmount },
    });
  });

  it('records nothing when the checkout rolls back', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ stock: 1 });
    const cartItemId = await addToCart(userId, item, 1);
    await makeAddress(userId);

    // Somebody else took the last unit after the shopper opened 确认订单. The
    // whole transaction goes, and a 订单提交成功 about an order that does not
    // exist is the worst kind of message to leave behind.
    await harness.ctx.db
      .update(productSkus)
      .set({ stock: 0 })
      .where(eq(productSkus.id, item.skuId));

    await expectDomainError(
      order.create(as(userId), {
        source: 'cart',
        cartItemIds: [String(cartItemId)],
        kind: 'normal',
        idempotencyKey: idempotencyKey(),
      }),
      'ORDER_OUT_OF_STOCK',
    );
    expect(await notificationKeys()).toEqual([]);
  });

  it('announces one order once, however many times the shopper taps 提交', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ stock: 10 });
    const cartItemId = await addToCart(userId, item, 1);
    await makeAddress(userId);
    const key = idempotencyKey();

    const first = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      idempotencyKey: key,
    });
    // The replay returns the first order without re-entering the transaction.
    const again = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      idempotencyKey: key,
    });

    expect(again.id).toBe(first.id);
    expect(await notificationKeys()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// the stock port
// ---------------------------------------------------------------------------

describe('the stock port', () => {
  /**
   * STOCK-001. A stock helper that accepts any number reports success for `0`
   * against no movement, and adds inventory for a negative one while counting a
   * sale.
   */
  it('refuses a line of zero, negative or fractional units without touching anything', async () => {
    const item = await makeProduct({ stock: 10 });
    const port = order.resolveStockPort();

    for (const quantity of [0, -1, 1.5]) {
      const failed = await harness.ctx
        .withTx(async (tx) => port.reserve(tx, 1, [{ skuId: item.skuId, quantity }]))
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(failed, `expected ${quantity} to be refused`).toBeInstanceOf(Error);
    }

    expect(await stockAndSalesOf(harness.ctx.db, item.skuId)).toEqual({ stock: 10, sales: 0 });
  });

  /**
   * STOCK-002, at the port itself rather than through checkout. The port's
   * contract is "name the short lines; the caller aborts its transaction" —
   * which is what checkout does — so the test plays the caller and proves the
   * abort leaves the plentiful line untouched too.
   */
  it('takes nothing when one line of several is short, and names that line', async () => {
    const plenty = await makeProduct({ stock: 10 });
    const scarce = await makeProduct({ stock: 1 });

    let short: StockLine[] = [];
    const aborted = await harness.ctx
      .withTx(async (tx) => {
        short = await order.resolveStockPort().reserve(tx, 1, [
          { skuId: plenty.skuId, quantity: 2 },
          { skuId: scarce.skuId, quantity: 2 },
        ]);
        if (short.length > 0) throw new DomainError('ORDER_OUT_OF_STOCK');
      })
      .then(
        () => false,
        () => true,
      );

    expect(aborted).toBe(true);
    expect(short).toEqual([{ skuId: scarce.skuId, quantity: 2 }]);
    expect(await stockAndSalesOf(harness.ctx.db, plenty.skuId)).toEqual({ stock: 10, sales: 0 });
    expect(await stockAndSalesOf(harness.ctx.db, scarce.skuId)).toEqual({ stock: 1, sales: 0 });
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

async function makeOrder(options: { coupon?: boolean; quantity?: number } = {}) {
  const userId = await makeUser();
  const item = await makeProduct({ stock: 10 });
  const cartItemId = await addToCart(userId, item, options.quantity ?? 2);
  await makeAddress(userId);
  const couponId = options.coupon
    ? await makeCoupon(userId, { discount: '10.00', minSpend: '0.00' })
    : null;

  const detail = await order.create(as(userId), {
    source: 'cart',
    cartItemIds: [String(cartItemId)],
    kind: 'normal',
    ...(couponId ? { userCouponId: String(couponId) } : {}),
    idempotencyKey: idempotencyKey(),
  });
  harness.queue.reset();
  return { userId, item, couponId, orderId: Number(detail.id), detail };
}

describe('cancellation', () => {
  it('gives back the stock and the coupon, and stamps the row', async () => {
    const { userId, item, couponId, orderId } = await makeOrder({ coupon: true });
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(8);

    const detail = await order.cancel(as(userId), { id: String(orderId) }, { reason: '不想要了' });

    expect(detail.status).toBe('cancelled');
    expect(detail.cancelReason).toBe('不想要了');
    expect(detail.cancelledAt).toBe('2026-06-01T00:00:00.000Z');
    expect(detail.payExpiresAt).toBeNull();

    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(10);
    const [wallet] = await harness.ctx.db
      .select()
      .from(userCoupons)
      .where(eq(userCoupons.id, couponId!));
    expect(wallet?.status).toBe('unused');

    const logs = await harness.ctx.db.select().from(orderStatusLogs);
    expect(logs.map((row) => row.changeType)).toEqual(['created', 'cancelled']);
  });

  it('refuses a second cancellation', async () => {
    const { userId, orderId } = await makeOrder();
    await order.cancel(as(userId), { id: String(orderId) }, {});
    await expectDomainError(
      order.cancel(as(userId), { id: String(orderId) }, {}),
      'ORDER_NOT_CANCELLABLE',
    );
  });

  it('refuses a stranger with the same 404 an unknown id gets', async () => {
    const { orderId } = await makeOrder();
    const stranger = await makeUser();
    await expectDomainError(
      order.cancel(as(stranger), { id: String(orderId) }, {}),
      'ORDER_NOT_FOUND',
    );
  });

  it('refuses, and releases nothing, when the gateway says the money arrived', async () => {
    const { userId, item, orderId } = await makeOrder();
    registerPaymentPort(fakePaymentPort({ result: 'paid' }));

    await expectDomainError(
      order.cancel(as(userId), { id: String(orderId) }, {}),
      'ORDER_ALREADY_PAID',
    );
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(8);
    const [row] = await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row?.status).toBe('pending_payment');
  });

  it('refuses, and releases nothing, when the gateway will not answer', async () => {
    const { userId, item, couponId, orderId } = await makeOrder({ coupon: true });
    registerPaymentPort(fakePaymentPort({ result: 'unknown' }));

    await expectDomainError(
      order.cancel(as(userId), { id: String(orderId) }, {}),
      'ORDER_PAYMENT_STATE_UNKNOWN',
    );
    // Never guess: the stock stays reserved and the coupon stays spent.
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(8);
    const [wallet] = await harness.ctx.db
      .select()
      .from(userCoupons)
      .where(eq(userCoupons.id, couponId!));
    expect(wallet?.status).toBe('used');
  });

  /**
   * QUEUE-006. Releasing the coupon and the stock in two calls with no shared
   * transaction would let a stock failure leave a returned coupon and a
   * cancelled order whose inventory had not come back.
   */
  it('rolls the whole cancellation back when the stock cannot be returned', async () => {
    const { userId, item, couponId, orderId } = await makeOrder({ coupon: true });
    const real = order.resolveStockPort();
    registerStockPort({
      reserve: real.reserve.bind(real),
      commit: real.commit.bind(real),
      release: () => Promise.reject(new Error('inventory service is down')),
    });

    const failed = await order.cancel(as(userId), { id: String(orderId) }, {}).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(failed).toBeInstanceOf(Error);
    const [row] = await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row?.status).toBe('pending_payment');
    expect(row?.cancelledAt).toBeNull();
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(8);
    const [wallet] = await harness.ctx.db
      .select()
      .from(userCoupons)
      .where(eq(userCoupons.id, couponId!));
    expect(wallet?.status).toBe('used');
    const logs = await harness.ctx.db.select().from(orderStatusLogs);
    expect(logs.map((log) => log.changeType)).toEqual(['created']);
  });

  /** QUEUE-007, the other half: a coupon that will not come back keeps the stock reserved. */
  it('gives nothing back when the coupon cannot be returned', async () => {
    const { userId, item, couponId, orderId } = await makeOrder({ coupon: true });
    // Somebody else already put this coupon back, so the conditional release
    // finds nothing to do and reports failure.
    await harness.ctx.db
      .update(userCoupons)
      .set({ status: 'unused', usedAt: null })
      .where(eq(userCoupons.id, couponId!));

    await expectDomainError(
      order.cancel(as(userId), { id: String(orderId) }, {}),
      'ORDER_COUPON_RELEASE_FAILED',
    );

    const [row] = await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row?.status).toBe('pending_payment');
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(8);
    const logs = await harness.ctx.db.select().from(orderStatusLogs);
    expect(logs.map((log) => log.changeType)).toEqual(['created']);
  });

  it('never cancels a paid order — that road leads through a refund', async () => {
    const { userId, orderId } = await makeOrder();
    await harness.ctx.db
      .update(orders)
      .set({ status: 'paid', paidAt: harness.clock.now(), paidAmount: '120.00' })
      .where(eq(orders.id, orderId));

    await expectDomainError(
      order.cancel(as(userId), { id: String(orderId) }, {}),
      'ORDER_NOT_CANCELLABLE',
    );
  });
});

describe('auto-cancel', () => {
  it('does nothing while the payment window is still open', async () => {
    const { item, orderId } = await makeOrder();
    const outcome = await order.autoCancel(harness.ctx, { orderId });

    expect(outcome.cancelled).toBe(false);
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(8);
  });

  it('cancels once the window has closed, and logs it as automatic', async () => {
    const { item, orderId } = await makeOrder();
    harness.clock.set('2026-06-01T00:31:00.000Z');

    const outcome = await order.autoCancel(harness.ctx, { orderId });

    expect(outcome).toEqual({ cancelled: true, status: 'cancelled' });
    expect((await stockAndSalesOf(harness.ctx.db, item.skuId)).stock).toBe(10);
    const logs = await harness.ctx.db.select().from(orderStatusLogs);
    expect(logs.map((row) => row.changeType)).toEqual(['created', 'auto_cancelled']);
  });

  it('is a no-op the second time, so the queue may retry it', async () => {
    const { orderId } = await makeOrder();
    harness.clock.set('2026-06-01T00:31:00.000Z');

    await order.autoCancel(harness.ctx, { orderId });
    const again = await order.autoCancel(harness.ctx, { orderId });
    expect(again).toEqual({ cancelled: false, status: 'cancelled' });
  });

  it('sweeps every expired order and leaves the live ones alone', async () => {
    const expired = await makeOrder();
    harness.clock.set('2026-06-01T00:31:00.000Z');
    const live = await makeOrder();

    const report = await order.sweepExpiredOrders(harness.ctx);

    expect(report).toEqual({ scanned: 1, cancelled: 1, skipped: 0 });
    const rows = await harness.ctx.db.select().from(orders);
    const byId = new Map(rows.map((row) => [row.id, row.status]));
    expect(byId.get(expired.orderId)).toBe('cancelled');
    expect(byId.get(live.orderId)).toBe('pending_payment');
  });
});

describe('未付款提醒 — ORDER-015', () => {
  // `truncateAll` empties `config_values` but not Redis: drop the cached group
  // so a lead time one test saves is not read by the next.
  beforeEach(async () => {
    await harness.ctx.config.invalidate(orderConfig.group);
  });

  const reminders = () => harness.queue.jobs.filter((job) => job.jobName === 'order.remindUnpaid');

  async function reminderPayload(orderId: number) {
    const [row] = await harness.ctx.db
      .select({ payload: effectsTable.payload })
      .from(effectsTable)
      .where(eq(effectsTable.scopeId, `order_unpaid_reminder:order:${orderId}`));
    return row?.payload as { data: Record<string, unknown> } | undefined;
  }

  it('reminds once, with the cancel time as the shopper reads it', async () => {
    const { userId, orderId, detail } = await makeOrder();
    harness.clock.set('2026-06-01T00:20:00.000Z');

    expect(await order.remindUnpaid(harness.ctx, { orderId })).toEqual({ sent: true });
    // A retried or re-enqueued job: still one message.
    expect(await order.remindUnpaid(harness.ctx, { orderId })).toEqual({ sent: true });

    const keys = await notificationKeys();
    expect(keys.filter((key) => key.startsWith('order_unpaid_reminder:'))).toEqual([
      `order_unpaid_reminder:order:${orderId}`,
    ]);
    const payload = await reminderPayload(orderId);
    expect(payload).toMatchObject({
      userId,
      data: {
        orderId,
        orderNo: detail.orderNo,
        amount: detail.payableAmount,
        // 00:30 UTC is 08:30 in Shanghai.
        expiresAt: '2026-06-01 08:30',
      },
    });
  });

  it('says nothing about an order already paid', async () => {
    const { orderId } = await makeOrder();
    await harness.ctx.db
      .update(orders)
      .set({ status: 'paid', paidAt: harness.clock.now(), paidAmount: '120.00' })
      .where(eq(orders.id, orderId));

    expect(await order.remindUnpaid(harness.ctx, { orderId })).toEqual({ sent: false });
    expect(await reminderPayload(orderId)).toBeUndefined();
  });

  it('says nothing about a cancelled order, and the cancel withdraws the queued reminder', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ stock: 10 });
    const cartItemId = await addToCart(userId, item, 1);
    await makeAddress(userId);
    const detail = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      idempotencyKey: idempotencyKey(),
    });
    const orderId = Number(detail.id);
    expect(reminders()).toHaveLength(1);

    await order.cancel(as(userId), { id: detail.id }, {});

    expect(reminders()).toEqual([]);
    expect(await order.remindUnpaid(harness.ctx, { orderId })).toEqual({ sent: false });
    expect(await reminderPayload(orderId)).toBeUndefined();
  });

  it('says nothing once the window has closed', async () => {
    const { orderId } = await makeOrder();
    harness.clock.set('2026-06-01T00:30:00.000Z');

    expect(await order.remindUnpaid(harness.ctx, { orderId })).toEqual({ sent: false });
    expect(await reminderPayload(orderId)).toBeUndefined();
  });

  it.each([
    ['is off', { unpaidReminderMinutes: 0 }],
    ['would come at or before the order', { payWindowMinutes: 10, unpaidReminderMinutes: 10 }],
    ['is longer than the window', { payWindowMinutes: 5, unpaidReminderMinutes: 10 }],
  ] as const)('schedules no reminder when it %s', async (_case, values) => {
    await harness.ctx.config.set(orderConfig, values);
    const userId = await makeUser();
    const item = await makeProduct({ stock: 10 });
    const cartItemId = await addToCart(userId, item, 1);
    await makeAddress(userId);

    await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      idempotencyKey: idempotencyKey(),
    });

    expect(reminders()).toEqual([]);
    expect(harness.queue.jobs.map((job) => job.jobName)).toEqual(['order.autoCancel']);
  });

  it('follows the configured lead time', async () => {
    await harness.ctx.config.set(orderConfig, { payWindowMinutes: 60, unpaidReminderMinutes: 15 });
    const userId = await makeUser();
    const item = await makeProduct({ stock: 10 });
    const cartItemId = await addToCart(userId, item, 1);
    await makeAddress(userId);

    await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      idempotencyKey: idempotencyKey(),
    });

    expect(reminders()).toMatchObject([{ options: { delay: 45 * 60_000 } }]);
  });
});

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

describe('my orders', () => {
  it('lists, counts and details only the caller’s own orders', async () => {
    const mine = await makeOrder();
    await makeOrder();

    const listed = await order.list(as(mine.userId), {
      page: 1,
      pageSize: 20,
      tab: 'all',
      sortOrder: 'desc',
    });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.id).toBe(String(mine.orderId));
    expect(listed.items[0]?.items).toHaveLength(1);

    expect(await order.counts(as(mine.userId))).toEqual({
      all: 1,
      unpaid: 1,
      unshipped: 0,
      unreceived: 0,
      finished: 0,
      cancelled: 0,
      refunding: 0,
      unreviewed: 0,
    });

    const detail = await order.detail(as(mine.userId), { id: String(mine.orderId) });
    expect(detail.orderNo).toHaveLength(24);
  });

  it('puts the tabs where the storefront expects them', async () => {
    const { userId, orderId } = await makeOrder();
    await harness.ctx.db
      .update(orders)
      .set({
        status: 'shipped',
        fulfillmentStatus: 'fulfilled',
        paidAt: harness.clock.now(),
        paidAmount: '120.00',
      })
      .where(eq(orders.id, orderId));

    const counts = await order.counts(as(userId));
    expect(counts).toMatchObject({ all: 1, unpaid: 0, unreceived: 1 });

    const unreceived = await order.list(as(userId), {
      page: 1,
      pageSize: 20,
      tab: 'unreceived',
      sortOrder: 'desc',
    });
    expect(unreceived.total).toBe(1);
    // The countdown is gone the moment the order leaves `pending_payment`.
    expect(unreceived.items[0]?.payExpiresAt).toBeNull();
  });

  it('finds an order by its number and by a product name', async () => {
    const { userId, orderId } = await makeOrder();
    const [row] = await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId));

    const byNo = await order.list(as(userId), {
      page: 1,
      pageSize: 20,
      tab: 'all',
      keyword: row!.orderNo.slice(-6),
      sortOrder: 'desc',
    });
    expect(byNo.total).toBe(1);

    const byName = await order.list(as(userId), {
      page: 1,
      pageSize: 20,
      tab: 'all',
      keyword: '商品',
      sortOrder: 'desc',
    });
    expect(byName.total).toBe(1);

    // `%` and `_` are what the shopper typed, not wildcards that list everything.
    for (const keyword of ['%', '_']) {
      const literal = await order.list(as(userId), {
        page: 1,
        pageSize: 20,
        tab: 'all',
        keyword,
        sortOrder: 'desc',
      });
      expect(literal.total).toBe(0);
    }
  });

  it('answers a stranger’s detail request with the same 404 as an unknown id', async () => {
    const { orderId } = await makeOrder();
    const stranger = await makeUser();
    await expectDomainError(order.detail(as(stranger), { id: String(orderId) }), 'ORDER_NOT_FOUND');
    await expectDomainError(order.detail(as(stranger), { id: '999999' }), 'ORDER_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// review state and 待评价
// ---------------------------------------------------------------------------

describe('ORDER-010 — review state on the shopper’s lines, and 待评价', () => {
  beforeEach(() => {
    // `resetOrderPorts` cleared it; `reviewSubmit` asks it whether a line may be reviewed.
    registerOrderFacts(orderFacts);
  });

  /** A two-line order, moved to `status` with the shape the CHECKs demand. */
  async function twoLineOrder(status: 'paid' | 'shipped' | 'received' | 'completed') {
    const userId = await makeUser();
    const first = await makeProduct();
    const second = await makeProduct();
    const cartItemIds = [await addToCart(userId, first), await addToCart(userId, second)];
    await makeAddress(userId);
    const created = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: cartItemIds.map(String),
      kind: 'normal',
      idempotencyKey: idempotencyKey(),
    });
    harness.queue.reset();
    const now = harness.clock.now();
    await harness.ctx.db
      .update(orders)
      .set({
        status,
        fulfillmentStatus: status === 'paid' ? 'unfulfilled' : 'fulfilled',
        paidAt: now,
        paidAmount: created.payableAmount,
        receivedAt: status === 'received' || status === 'completed' ? now : null,
        completedAt: status === 'completed' ? now : null,
      })
      .where(eq(orders.id, Number(created.id)));
    const [a, b] = created.items.map((item) => item.id);
    return { userId, orderId: created.id, lineIds: [a!, b!] as const };
  }

  const review = (userId: number, orderItemId: string) =>
    reviewSubmit(as(userId), {
      orderItemId,
      productScore: 5,
      serviceScore: 5,
      content: '不错',
      images: [],
    });

  const stateOf = async (userId: number, orderId: string) =>
    (await order.detail(as(userId), { id: orderId })).items.map((item) => ({
      reviewed: item.reviewed,
      reviewable: item.reviewable,
    }));

  it('marks a line reviewable only once received, and reviewed once written — held or not', async () => {
    const paid = await twoLineOrder('paid');
    expect(await stateOf(paid.userId, paid.orderId)).toEqual([
      { reviewed: false, reviewable: false },
      { reviewed: false, reviewable: false },
    ]);

    const { userId, orderId, lineIds } = await twoLineOrder('received');
    expect(await stateOf(userId, orderId)).toEqual([
      { reviewed: false, reviewable: true },
      { reviewed: false, reviewable: true },
    ]);

    await review(userId, lineIds[0]);
    expect(await stateOf(userId, orderId)).toEqual([
      { reviewed: true, reviewable: false },
      { reviewed: false, reviewable: true },
    ]);

    // The list says the same as the detail.
    const listed = await order.list(as(userId), {
      page: 1,
      pageSize: 20,
      tab: 'all',
      sortOrder: 'desc',
    });
    expect(listed.items[0]?.items.map((item) => item.reviewable)).toEqual([false, true]);
  });

  it('agrees with what reviewSubmit accepts: a fully refunded line is not reviewable', async () => {
    const { userId, orderId, lineIds } = await twoLineOrder('completed');
    await harness.ctx.db
      .update(orderItems)
      .set({ refundedQuantity: 1 })
      .where(eq(orderItems.id, Number(lineIds[1])));

    expect(await stateOf(userId, orderId)).toEqual([
      { reviewed: false, reviewable: true },
      { reviewed: false, reviewable: false },
    ]);
    await expectDomainError(review(userId, lineIds[1]), 'CATALOG_REVIEW_NOT_ALLOWED');
    await review(userId, lineIds[0]);
    await expectDomainError(review(userId, lineIds[0]), 'CATALOG_REVIEW_ALREADY_WRITTEN');
    expect(await stateOf(userId, orderId)).toEqual([
      { reviewed: true, reviewable: false },
      { reviewed: false, reviewable: false },
    ]);
  });

  const unreviewedTab = async (userId: number) =>
    (
      await order.list(as(userId), { page: 1, pageSize: 20, tab: 'unreviewed', sortOrder: 'desc' })
    ).items.map((item) => item.id);

  it('counts 待评价 as the orders with a reviewable line, and the tab lists exactly those', async () => {
    const received = await twoLineOrder('received');
    const userId = received.userId;
    expect(await order.counts(as(userId))).toMatchObject({ finished: 1, unreviewed: 1 });
    expect(await unreviewedTab(userId)).toEqual([received.orderId]);

    // One line reviewed: the other still owes one, so the order stays.
    await review(userId, received.lineIds[0]);
    expect(await order.counts(as(userId))).toMatchObject({ unreviewed: 1 });

    // Both reviewed: it leaves 待评价 and stays 已完成.
    await review(userId, received.lineIds[1]);
    expect(await order.counts(as(userId))).toMatchObject({ finished: 1, unreviewed: 0 });
    expect(await unreviewedTab(userId)).toEqual([]);
  });

  it('leaves out an order not yet received, one refunded line by line, and another shopper’s', async () => {
    const { userId, orderId, lineIds } = await twoLineOrder('completed');
    const other = await twoLineOrder('completed');
    // Not received yet: nothing to review, whatever its lines.
    const shipped = await twoLineOrder('shipped');
    expect(await order.counts(as(shipped.userId))).toMatchObject({ unreviewed: 0 });

    await harness.ctx.db
      .update(orderItems)
      .set({ refundedQuantity: 1 })
      .where(eq(orderItems.id, Number(lineIds[1])));
    await review(userId, lineIds[0]);
    // One line reviewed, the other refunded in full: nothing left to review.
    expect(await order.counts(as(userId))).toMatchObject({ finished: 1, unreviewed: 0 });
    expect(await unreviewedTab(userId)).toEqual([]);
    expect(await unreviewedTab(other.userId)).toEqual([other.orderId]);
    expect(orderId).not.toBe(other.orderId);
  });

  it('stops counting a line once the auto-review job has written its default review', async () => {
    const { userId } = await twoLineOrder('completed');
    expect(await order.counts(as(userId))).toMatchObject({ unreviewed: 1 });
    harness.clock.set('2026-06-30T00:00:00.000Z');
    const swept = await runAutoReview(harness.ctx);
    expect(swept.written).toBe(2);
    expect(await order.counts(as(userId))).toMatchObject({ finished: 1, unreviewed: 0 });
  });
});

// ---------------------------------------------------------------------------
// 删除订单
// ---------------------------------------------------------------------------

describe('hiding a finished order', () => {
  /**
   * Puts an order into a terminal state without going through the gateway.
   *
   * The whole row has to move, not just `status`: `orders_paid_shape`,
   * `orders_cancelled_shape` and `orders_fulfillment_matches_status` between
   * them refuse a completed order that was never paid or never shipped. Writing
   * a shape the database would never hold would make these tests prove nothing.
   */
  async function finish(orderId: number, status: 'completed' | 'cancelled' | 'refunded') {
    const paid = status !== 'cancelled';
    await harness.ctx.db
      .update(orders)
      .set({
        status,
        fulfillmentStatus: status === 'completed' ? 'fulfilled' : 'unfulfilled',
        refundStatus: status === 'refunded' ? 'refunded' : 'none',
        paidAt: paid ? harness.clock.now() : null,
        paidAmount: paid ? '120.00' : null,
        refundedAmount: status === 'refunded' ? '120.00' : '0.00',
        cancelledAt: status === 'cancelled' ? harness.clock.now() : null,
        completedAt: status === 'completed' ? harness.clock.now() : null,
      })
      .where(eq(orders.id, orderId));
  }

  it('takes the order out of the buyer’s list and leaves the row for the shop', async () => {
    const { userId, orderId } = await makeOrder();
    await finish(orderId, 'completed');

    expect(await order.hide(as(userId), { id: String(orderId) })).toEqual({ hidden: true });

    const listed = await order.list(as(userId), {
      page: 1,
      pageSize: 20,
      tab: 'all',
      sortOrder: 'desc',
    });
    expect(listed.total).toBe(0);
    expect(await order.counts(as(userId))).toMatchObject({ all: 0, finished: 0 });
    await expectDomainError(order.detail(as(userId), { id: String(orderId) }), 'ORDER_NOT_FOUND');

    // The shop's copy is untouched apart from the stamp.
    const [row] = await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row!.status).toBe('completed');
    expect(row!.hiddenByUserAt).toBeInstanceOf(Date);
    expect(row!.deletedAt).toBeNull();

    const logs = await harness.ctx.db.select().from(orderStatusLogs);
    const hidden = logs.filter((log) => log.changeType === 'hidden_by_user');
    expect(hidden).toHaveLength(1);
    // A visibility change, not a transition: neither status column is claimed.
    expect(hidden[0]).toMatchObject({ fromStatus: null, toStatus: null, operatorKind: 'user' });
    expect(hidden[0]!.operatorUserId).toBe(userId);
  });

  it('accepts the order number as well as the id', async () => {
    const { userId, orderId, detail } = await makeOrder();
    await finish(orderId, 'cancelled');

    expect(await order.hide(as(userId), { id: detail.orderNo })).toEqual({ hidden: true });
  });

  it.each(['completed', 'cancelled', 'refunded'] as const)('allows %s', async (status) => {
    const { userId, orderId } = await makeOrder();
    await finish(orderId, status);
    expect(await order.hide(as(userId), { id: String(orderId) })).toEqual({ hidden: true });
  });

  it('refuses an order that is still in flight, and says which it is', async () => {
    const { userId, orderId } = await makeOrder();

    await expectDomainError(order.hide(as(userId), { id: String(orderId) }), 'ORDER_NOT_DELETABLE');
    const [row] = await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row!.hiddenByUserAt).toBeNull();
  });

  it('answers a second tap, a stranger and an unknown id all with the same 404', async () => {
    const { userId, orderId } = await makeOrder();
    await finish(orderId, 'completed');
    const stranger = await makeUser();

    await order.hide(as(userId), { id: String(orderId) });
    // Already hidden: to this buyer the order no longer exists, so saying
    // "not deletable" would confirm a row they can no longer see.
    await expectDomainError(order.hide(as(userId), { id: String(orderId) }), 'ORDER_NOT_FOUND');
    await expectDomainError(order.hide(as(stranger), { id: String(orderId) }), 'ORDER_NOT_FOUND');
    await expectDomainError(order.hide(as(stranger), { id: '999999' }), 'ORDER_NOT_FOUND');
  });

  it('stamps once and logs once when the button is tapped twice at the same moment', async () => {
    const { userId, orderId } = await makeOrder();
    await finish(orderId, 'completed');

    const outcomes = await runConcurrently(
      4,
      async () => {
        try {
          await order.hide(forkTestCtx(harness, { actor: userActor(userId), platform: 'h5' }), {
            id: String(orderId),
          });
          return { won: true, code: null as string | null };
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          return { won: false, code: error.code };
        }
      },
      { isWinner: (outcome) => outcome.won },
    );

    expect(outcomes.winners).toBe(1);
    expect(outcomes.fulfilled.filter((o) => !o.won).map((o) => o.code)).toEqual([
      'ORDER_NOT_FOUND',
      'ORDER_NOT_FOUND',
      'ORDER_NOT_FOUND',
    ]);
    const logs = await harness.ctx.db.select().from(orderStatusLogs);
    expect(logs.filter((log) => log.changeType === 'hidden_by_user')).toHaveLength(1);
  });
});

/**
 * Checkout's `create` and fulfilment's `autoDeliver` each read a config group
 * while their transaction is open. Through `ctx.config.get` a cold cache would
 * take a second pooled connection for that read: `max` checkouts at once, each
 * holding one connection and waiting for another. On a pool of one that is not
 * a race but a certainty, so these run on a pool of one with the cache emptied
 * first. Reading through `ctx.config.get` instead of `getIn` fails both at the
 * acquire timeout.
 */
describe('config read through the transaction, not a second connection', () => {
  async function onPoolOfOne<T>(userId: number | null, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    const small = createDb(harness.db.url, { max: 1, acquireTimeoutMs: 1_000 });
    small.pool.on('error', () => {});
    try {
      const base = { ...harness, db: { ...harness.db, db: small.db } } as TestCtx;
      const ctx = forkTestCtx(base, {
        ...(userId === null ? {} : { actor: userActor(userId) }),
        platform: 'h5',
      });
      await ctx.config.invalidate(orderConfig.group);
      await ctx.config.invalidate(orderFulfilConfig.group);
      return await fn(ctx);
    } finally {
      await small.close().catch(() => {});
    }
  }

  it('places an order, freight quote included, on a pool of one with a cold config cache', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ freight: '8.00' });
    const cartItemId = await addToCart(userId, item, 1);
    await makeAddress(userId);

    const detail = await onPoolOfOne(userId, (ctx) =>
      order.create(ctx, {
        source: 'cart',
        cartItemIds: [String(cartItemId)],
        kind: 'normal',
        idempotencyKey: idempotencyKey(),
      }),
    );

    expect(detail.status).toBe('pending_payment');
    expect(detail.freightAmount).toBe('8.00');
  });

  it('auto-delivers a virtual order on a pool of one with a cold config cache', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ kind: 'virtual_card' });
    await harness.ctx.db
      .insert(productVirtualCards)
      .values([{ productId: item.productId, skuId: item.skuId, cardKey: 'KEY-1', cardNo: 'NO-1' }]);
    const cartItemId = await addToCart(userId, item, 1);
    const detail = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [String(cartItemId)],
      kind: 'normal',
      idempotencyKey: idempotencyKey(),
    });
    const orderId = Number(detail.id);
    await harness.ctx.db
      .update(orders)
      .set({ status: 'paid', paidAt: harness.clock.now(), paidAmount: '60.00' })
      .where(eq(orders.id, orderId));

    const outcome = await onPoolOfOne(null, (ctx) => autoDeliver(ctx, orderId));

    expect(outcome).toMatchObject({ delivered: true, fulfilled: true });
    const [row] = await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row!.status).toBe('shipped');
    expect(row!.autoReceiveAt).not.toBeNull();
  });
});
