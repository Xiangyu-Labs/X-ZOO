import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { products, productSkus } from '@shop/db/schema/catalog';
import { presaleActivities, presaleActivitySkus, presaleOrders } from '@shop/db/schema/presale';
import { orders } from '@shop/db/schema/order';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import type { Actor, Ctx } from '../kernel/context';
import { Money } from '../kernel/money';
import { registerPricingContributor, resetOrderPorts } from '../order/ports';
import { registerAllDomains } from '../domains.gen';
import { registerShippingFreightPort } from '../shipping';
import * as checkout from '../order/index';
import * as repo from './presale.repo';

/**
 * 预售 through the real checkout, end to end.
 *
 * The other presale tests drive `presaleKindHandler` directly, which is the
 * right level for stock, stages and ledgers. This one exists for the seam
 * itself: `buildDraft` hands `kind` and `kindMeta` to the pricing
 * contributors, so `presalePricingContributor` has to fire on a real
 * `checkout.preview` and the shopper has to be quoted 预售价 rather than the
 * catalogue price.
 *
 * Every domain is registered the way the web process registers them, because a
 * presale checkout needs the catalog's catalogue and stock ports as much as it
 * needs this one.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';
/** The catalogue price. */
const LIST = '88.00';
/** The campaign price. */
const PRESALE = '59.00';

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
  // `resetOrderPorts()` clears the freight port too, and shipping registers it
  // as a module side effect — which has already run. The checkout has no
  // fallback, so without this it throws rather than quoting zero.
  registerShippingFreightPort();
});

afterEach(() => {
  resetOrderPorts();
});

const asUser = (id: number): Ctx =>
  harness.as({ kind: 'user', id, permissions: [], isSuper: false } satisfies Actor);

let sequence = 0;

interface Fixture {
  userId: number;
  activityId: number;
  productId: number;
  skuId: number;
}

async function seed(over: { stock?: number; perOrderQuantity?: number } = {}): Promise<Fixture> {
  sequence += 1;
  const stock = over.stock ?? 100;

  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: `ps-co-${sequence}`, nickname: '小明' })
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

  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: '明前龙井',
      imageUrl: 'https://example.test/p.png',
      freightMode: 'free',
      status: 'on_shelf',
      price: LIST,
      stock: 1_000,
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `LJ-${sequence}`,
      specText: '一级|250g',
      specValues: { 等级: '一级' },
      price: LIST,
      originalPrice: '108.00',
      stock: 1_000,
    })
    .returning({ id: productSkus.id });

  const [activity] = await harness.ctx.db
    .insert(presaleActivities)
    .values({
      productId: product!.id,
      title: '春茶预售 · 明前龙井',
      status: 'active',
      paymentMode: 'full',
      price: PRESALE,
      stock,
      perOrderQuantity: over.perOrderQuantity ?? 3,
      startAt: new Date('2026-05-01T00:00:00.000Z'),
      endAt: new Date('2026-07-01T00:00:00.000Z'),
      shipAfterDays: 15,
    })
    .returning({ id: presaleActivities.id });
  await harness.ctx.db.insert(presaleActivitySkus).values({
    activityId: activity!.id,
    skuId: sku!.id,
    price: PRESALE,
    stock,
    isEnabled: true,
  });

  return {
    userId: user!.id,
    activityId: activity!.id,
    productId: product!.id,
    skuId: sku!.id,
  };
}

const buyNow = (fixture: Fixture, quantity: number) => ({
  source: 'buy-now' as const,
  cartItemIds: [],
  item: { skuId: String(fixture.skuId), quantity },
  kind: 'presale' as const,
  kindMeta: { activityId: String(fixture.activityId) },
});

// ---------------------------------------------------------------------------

describe('确认订单', () => {
  it('quotes 预售价, not the catalogue price', async () => {
    const fixture = await seed();
    const preview = await checkout.preview(asUser(fixture.userId), buyNow(fixture, 2));

    // The goods line still shows what the SKU costs; the campaign takes the
    // difference off as a named discount, which is how every goods-level
    // reduction reaches `orders.coupon_discount`.
    expect(preview.itemsAmount).toBe('176.00');
    expect(preview.payableAmount).toBe('118.00');
    expect(preview.couponDiscount).toBe('58.00');
    expect(preview.adjustments).toContainEqual(
      expect.objectContaining({ source: 'presale:activity-price', amount: '-58.00' }),
    );
  });

  it('does not touch an ordinary order for the same SKU', async () => {
    const fixture = await seed();
    const preview = await checkout.preview(asUser(fixture.userId), {
      source: 'buy-now',
      cartItemIds: [],
      item: { skuId: String(fixture.skuId), quantity: 2 },
      kind: 'normal',
    });

    // The contributor refuses to fire without `kind: 'presale'`: a campaign
    // must not quietly discount a shopper who never chose it.
    expect(preview.payableAmount).toBe('176.00');
    expect(preview.adjustments).toEqual([]);
  });

  it('says when a presale order ships — the campaign’s days after payment — and nothing for an ordinary one', async () => {
    const fixture = await seed();
    const presale = await checkout.preview(asUser(fixture.userId), buyNow(fixture, 1));
    expect(presale.shipAfterDays).toBe(15);

    await harness.ctx.db
      .update(presaleActivities)
      .set({ shipAfterDays: 0 })
      .where(eq(presaleActivities.id, fixture.activityId));
    expect((await checkout.preview(asUser(fixture.userId), buyNow(fixture, 1))).shipAfterDays).toBe(
      0,
    );

    const ordinary = await checkout.preview(asUser(fixture.userId), {
      source: 'buy-now',
      cartItemIds: [],
      item: { skuId: String(fixture.skuId), quantity: 1 },
      kind: 'normal',
    });
    expect(ordinary.shipAfterDays).toBeNull();
  });

  it('quotes the catalogue price once the window has closed', async () => {
    const fixture = await seed();
    harness.clock.set('2026-08-01T00:00:00.000Z');
    const preview = await checkout.preview(asUser(fixture.userId), buyNow(fixture, 1));
    expect(preview.payableAmount).toBe(LIST);
  });
});

describe('提交订单', () => {
  const createBody = (fixture: Fixture, quantity: number, expected: string) => ({
    ...buyNow(fixture, quantity),
    idempotencyKey: `presale-${fixture.activityId}-${quantity}`,
    expectedPayableAmount: expected,
  });

  it('places a presale order at 预售价 and holds the campaign stock', async () => {
    const fixture = await seed({ stock: 10 });
    const ctx = asUser(fixture.userId);

    const order = await checkout.create(ctx, createBody(fixture, 2, '118.00'));
    expect(order.kind).toBe('presale');
    expect(order.payableAmount).toBe('118.00');

    // The presale row exists, on the only stage a full-payment campaign starts on.
    const [presale] = await harness.ctx.db
      .select()
      .from(presaleOrders)
      .where(eq(presaleOrders.orderId, Number(order.id)));
    expect(presale).toMatchObject({
      activityId: fixture.activityId,
      paymentMode: 'full',
      stage: 'final_pending',
      depositAmount: null,
    });

    // Both counters moved in the one transaction: the campaign's own and the
    // warehouse's.
    const [activity] = await harness.ctx.db
      .select()
      .from(presaleActivities)
      .where(eq(presaleActivities.id, fixture.activityId));
    expect(activity).toMatchObject({ stock: 8, sales: 0 });
    const [sku] = await harness.ctx.db
      .select()
      .from(productSkus)
      .where(eq(productSkus.id, fixture.skuId));
    expect(sku?.stock).toBe(998);

    const ledger = await repo.listStockLedger(harness.ctx.db, Number(order.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ reason: 'reserve', quantity: 2 });
  });

  it('refuses the order when the shopper was quoted a price that has since changed', async () => {
    const fixture = await seed({ stock: 10 });
    const ctx = asUser(fixture.userId);
    await expect(checkout.create(ctx, createBody(fixture, 2, '176.00'))).rejects.toMatchObject({
      code: 'ORDER_PRICE_CHANGED',
    });
    expect(await harness.ctx.db.select().from(orders)).toHaveLength(0);
  });

  it('refuses more than 每单限购, before anything is written', async () => {
    const fixture = await seed({ stock: 10, perOrderQuantity: 1 });
    const ctx = asUser(fixture.userId);
    await expect(checkout.create(ctx, createBody(fixture, 2, '118.00'))).rejects.toMatchObject({
      code: 'PRESALE_QUANTITY_NOT_ALLOWED',
    });
    expect(await harness.ctx.db.select().from(orders)).toHaveLength(0);
    const [activity] = await harness.ctx.db
      .select()
      .from(presaleActivities)
      .where(eq(presaleActivities.id, fixture.activityId));
    expect(activity?.stock).toBe(10);
  });

  it('refuses when the campaign is out of its own stock, with the warehouse full', async () => {
    const fixture = await seed({ stock: 1 });
    const ctx = asUser(fixture.userId);
    await checkout.create(ctx, createBody(fixture, 1, PRESALE));
    await expect(
      checkout.create(ctx, {
        ...createBody(fixture, 1, PRESALE),
        idempotencyKey: 'presale-second',
      }),
    ).rejects.toMatchObject({ code: 'PRESALE_OUT_OF_STOCK' });
    // The SKU reservation the failed attempt made rolled back with it.
    const [sku] = await harness.ctx.db
      .select()
      .from(productSkus)
      .where(eq(productSkus.id, fixture.skuId));
    expect(sku?.stock).toBe(999);
  });

  it('refuses a campaign whose window has closed', async () => {
    const fixture = await seed({ stock: 10 });
    harness.clock.set('2026-08-01T00:00:00.000Z');
    await expect(
      checkout.create(asUser(fixture.userId), createBody(fixture, 1, LIST)),
    ).rejects.toMatchObject({ code: 'PRESALE_ACTIVITY_NOT_OPEN' });
  });

  it('refuses a presale order whose price never reached it', async () => {
    // The guard that makes the campaign price fail closed rather than fail
    // quietly: if the contributor stops firing, the shopper is not billed the
    // catalogue price.
    const fixture = await seed({ stock: 10 });
    // The registry replaces by name, so a no-op under the same name is exactly
    // "the contributor stopped firing".
    registerPricingContributor({
      name: 'presale:activity-price',
      priority: 50,
      contribute: async () => [],
    });

    await expect(
      checkout.create(asUser(fixture.userId), createBody(fixture, 1, LIST)),
    ).rejects.toMatchObject({ code: 'PRESALE_PRICE_NOT_APPLIED' });
    expect(await harness.ctx.db.select().from(orders)).toHaveLength(0);
  });
});

describe('ORDER-009 — a presale kind smuggled into kindMeta', () => {
  // The contract strips it (`checkout-kind.test.ts`); this is the service's own
  // half, for a caller that reaches the checkout without the contract. `kind`
  // is written after the kind's payload, so `{ kind: 'presale' }` inside an
  // ordinary order's `kindMeta` cannot turn 预售价 on for an order that holds no
  // campaign stock and makes no 发货承诺.
  const smuggled = (fixture: Fixture, quantity: number) =>
    ({
      source: 'buy-now' as const,
      cartItemIds: [],
      item: { skuId: String(fixture.skuId), quantity },
      kind: 'normal' as const,
      kindMeta: { kind: 'presale', activityId: String(fixture.activityId) },
    }) as unknown as Parameters<typeof checkout.preview>[1];

  it('never quotes 预售价 on an ordinary order', async () => {
    const fixture = await seed();
    const preview = await checkout.preview(asUser(fixture.userId), smuggled(fixture, 2));
    expect(preview.payableAmount).toBe('176.00');
    expect(preview.adjustments).toEqual([]);
    expect(preview.shipAfterDays).toBeNull();
  });

  it('places it as an ordinary order at the catalogue price, and leaves the campaign alone', async () => {
    const fixture = await seed({ stock: 10 });
    const order = await checkout.create(asUser(fixture.userId), {
      ...smuggled(fixture, 1),
      idempotencyKey: `smuggled-${fixture.activityId}`,
    } as unknown as Parameters<typeof checkout.create>[1]);

    expect(order.kind).toBe('normal');
    expect(order.payableAmount).toBe(LIST);
    expect(
      await harness.ctx.db
        .select()
        .from(presaleOrders)
        .where(eq(presaleOrders.orderId, Number(order.id))),
    ).toHaveLength(0);
    const [activity] = await harness.ctx.db
      .select()
      .from(presaleActivities)
      .where(eq(presaleActivities.id, fixture.activityId));
    expect(activity).toMatchObject({ stock: 10, sales: 0 });
  });

  it('keeps a real presale order at 预售价 whatever else its kindMeta carries', async () => {
    const fixture = await seed();
    const preview = await checkout.preview(asUser(fixture.userId), {
      ...buyNow(fixture, 1),
      kindMeta: { activityId: String(fixture.activityId), kind: 'groupbuy', groupId: '1' },
    } as unknown as Parameters<typeof checkout.preview>[1]);
    expect(preview.payableAmount).toBe(PRESALE);
    expect(preview.adjustments).toEqual([
      expect.objectContaining({ source: 'presale:activity-price', amount: '-29.00' }),
    ]);
  });
});

/** `Money` is the only arithmetic here; this keeps the expectations honest. */
it('the campaign discount is exactly the difference', () => {
  expect(Money.parse(LIST).sub(Money.parse(PRESALE)).mul(2).toString()).toBe('58.00');
});
