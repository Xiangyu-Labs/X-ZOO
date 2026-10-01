import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cartItems } from '@shop/db/schema/cart';
import { orders } from '@shop/db/schema/order';
import { productSkus, products } from '@shop/db/schema/catalog';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
// The cart reads variants through the catalog's port, which registers on import.
import '../catalog';
import '../shipping';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import * as order from '../order';
import * as cart from './index';

/**
 * The cart against a real database.
 *
 * Two things are being protected here. The first is that an unsellable row is
 * *described*, never deleted behind the shopper's back. The second is
 * `addUnits`: 加入购物车 from two devices at once must end at the sum, in one
 * row, which is a property of the
 * `INSERT … ON CONFLICT (user_id, sku_id) DO UPDATE` statement and of nothing
 * in TypeScript.
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
});

let sequence = 0;

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const as = (userId: number): Ctx => harness.as(userActor(userId));
const racer = (userId: number): Ctx => forkTestCtx(harness, { actor: userActor(userId) });

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `cart-${sequence}` })
    .returning({ id: users.id });
  await harness.ctx.db.insert(userAddresses).values({
    userId: row!.id,
    receiverName: '张三',
    receiverPhone: '13800138000',
    provinceName: '浙江省',
    cityName: '杭州市',
    detail: '文三路 100 号',
    isDefault: true,
  });
  return row!.id;
}

interface ProductOptions {
  kind?: 'physical' | 'virtual_card';
  status?: 'draft' | 'on_shelf' | 'off_shelf';
  stock?: number;
  price?: string;
  purchaseLimit?: number;
  /** A `lifetime` limit instead of a per-order one. */
  lifetimeLimit?: number;
  minPurchaseQuantity?: number;
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
      imageUrl: 'https://cdn.example.com/p.jpg',
      unitName: '件',
      price: options.price ?? '60.00',
      stock: options.stock ?? 10,
      freightMode: 'free',
      minPurchaseQuantity: options.minPurchaseQuantity ?? 1,
      purchaseLimitMode: options.lifetimeLimit
        ? 'lifetime'
        : options.purchaseLimit
          ? 'per_order'
          : 'none',
      purchaseLimitQuantity: options.lifetimeLimit ?? options.purchaseLimit ?? null,
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
      stock: options.stock ?? 10,
      isDefault: true,
    })
    .returning({ id: productSkus.id });
  return { productId: product!.id, skuId: sku!.id };
}

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `expected ${code}, got success`).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
}

// ---------------------------------------------------------------------------

describe('adding to the cart', () => {
  it('creates a row, then adds to it rather than creating a second', async () => {
    const userId = await makeUser();
    const item = await makeProduct();

    const first = await cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 2 });
    expect(first.item?.quantity).toBe(2);
    expect(first.cart).toEqual({
      items: 1,
      quantity: 2,
      availableCount: 1,
      unavailableCount: 0,
    });

    const second = await cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 3 });
    expect(second.item?.quantity).toBe(5);
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(1);
  });

  it('refuses a variant that is not for sale', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ status: 'off_shelf' });
    await expectDomainError(
      cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 1 }),
      'CART_SKU_NOT_AVAILABLE',
    );
  });

  it('refuses more than there is in stock', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ stock: 2 });
    await expectDomainError(
      cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 3 }),
      'CART_OUT_OF_STOCK',
    );
  });

  it('refuses a second card key', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ kind: 'virtual_card' });
    await cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 1 });
    await expectDomainError(
      cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 1 }),
      'CART_VIRTUAL_CARD_QUANTITY',
    );
  });

  it('refuses to run past the per-order limit', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ purchaseLimit: 2 });
    await cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 2 });
    await expectDomainError(
      cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 1 }),
      'CART_PURCHASE_LIMIT_REACHED',
    );
  });
});

describe('listing the cart', () => {
  it('shows a dead row with a reason instead of dropping it', async () => {
    const userId = await makeUser();
    const live = await makeProduct();
    const dying = await makeProduct();
    await cart.addItem(as(userId), { skuId: String(live.skuId), quantity: 1 });
    await cart.addItem(as(userId), { skuId: String(dying.skuId), quantity: 1 });

    await harness.ctx.db
      .update(products)
      .set({ status: 'off_shelf' })
      .where(eq(products.id, dying.productId));

    const listed = await cart.list(as(userId), { page: 1, pageSize: 20, filter: 'all' });

    expect(listed.total).toBe(2);
    expect(listed.availableCount).toBe(1);
    expect(listed.unavailableCount).toBe(1);
    const dead = listed.items.find((row) => row.skuId === String(dying.skuId));
    expect(dead).toMatchObject({ available: false, state: 'off_shelf' });
    // Ticked but unsellable: it must not inflate the 结算 total.
    expect(listed.selectedTotal).toBe('60.00');
    expect(listed.selectedQuantity).toBe(1);
  });

  it('CAT-014: greys a row past a lifetime limit the shopper already used up, and names the rule', async () => {
    const userId = await makeUser();
    const limited = await makeProduct({ lifetimeLimit: 2 });
    await cart.addItem(as(userId), { skuId: String(limited.skuId), quantity: 2 });
    const bought = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      idempotencyKey: `lifetime-${(sequence += 1).toString().padStart(8, '0')}`,
    });
    await harness.ctx.db
      .update(orders)
      .set({ status: 'paid', paidAt: harness.clock.now(), paidAmount: bought.payableAmount })
      .where(eq(orders.id, Number(bought.id)));

    await cart.addItem(as(userId), { skuId: String(limited.skuId), quantity: 1 });
    const listed = await cart.list(as(userId), { page: 1, pageSize: 20, filter: 'all' });

    expect(listed.items[0]).toMatchObject({
      available: false,
      state: 'quantity_not_allowed',
      quantityRule: { kind: 'lifetime', limit: 2, purchased: 2 },
    });
    expect(listed.selectedQuantity).toBe(0);
  });

  it('reads the price live rather than from the row', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ price: '60.00' });
    await cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 2 });

    await harness.ctx.db
      .update(productSkus)
      .set({ price: '50.00' })
      .where(eq(productSkus.id, item.skuId));

    const listed = await cart.list(as(userId), { page: 1, pageSize: 20, filter: 'all' });
    expect(listed.items[0]?.unitPrice).toBe('50.00');
    expect(listed.items[0]?.subtotal).toBe('100.00');
  });

  it('filters to the sellable rows and to the dead ones', async () => {
    const userId = await makeUser();
    const live = await makeProduct();
    const dead = await makeProduct({ stock: 5 });
    await cart.addItem(as(userId), { skuId: String(live.skuId), quantity: 1 });
    await cart.addItem(as(userId), { skuId: String(dead.skuId), quantity: 5 });
    await harness.ctx.db
      .update(productSkus)
      .set({ stock: 1 })
      .where(eq(productSkus.id, dead.skuId));

    const available = await cart.list(as(userId), { page: 1, pageSize: 20, filter: 'available' });
    expect(available.total).toBe(1);

    const unavailable = await cart.list(as(userId), {
      page: 1,
      pageSize: 20,
      filter: 'unavailable',
    });
    expect(unavailable.total).toBe(1);
    expect(unavailable.items[0]?.state).toBe('out_of_stock');
  });

  it('counts rows and units for the badge', async () => {
    const userId = await makeUser();
    const a = await makeProduct();
    const b = await makeProduct();
    await cart.addItem(as(userId), { skuId: String(a.skuId), quantity: 2 });
    await cart.addItem(as(userId), { skuId: String(b.skuId), quantity: 3 });

    expect(await cart.count(as(userId))).toEqual({
      items: 2,
      quantity: 5,
      availableCount: 2,
      unavailableCount: 0,
    });
  });
});

describe('editing the cart', () => {
  it('sets an absolute quantity and the tick', async () => {
    const userId = await makeUser();
    const item = await makeProduct();
    const added = await cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 2 });
    const id = added.item!.id;

    const updated = await cart.updateItem(as(userId), { id }, { quantity: 5 });
    expect(updated.item?.quantity).toBe(5);

    const unticked = await cart.updateItem(as(userId), { id }, { isSelected: false });
    expect(unticked.item?.isSelected).toBe(false);
  });

  /**
   * The add path already refuses a second card; the edit path is the way round
   * it, because it sets an absolute quantity rather than adding to one.
   * `product_virtual_cards_order_item_uq` binds one card key to one order item,
   * so a line of two could only ever be half delivered.
   */
  it('refuses to edit a card-key row up to two', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ kind: 'virtual_card' });
    const added = await cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 1 });

    await expectDomainError(
      cart.updateItem(as(userId), { id: added.item!.id }, { quantity: 2 }),
      'CART_VIRTUAL_CARD_QUANTITY',
    );
    // The row is left exactly as it was — a refused edit is not a partial one.
    const listed = await cart.list(as(userId), { page: 1, pageSize: 20, filter: 'all' });
    expect(listed.items.map((row) => row.quantity)).toEqual([1]);
  });

  it('refuses to edit somebody else’s row, with the same code as a missing one', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const item = await makeProduct();
    const added = await cart.addItem(as(owner), { skuId: String(item.skuId), quantity: 1 });

    await expectDomainError(
      cart.updateItem(as(stranger), { id: added.item!.id }, { quantity: 2 }),
      'CART_ITEM_NOT_FOUND',
    );
    await expectDomainError(
      cart.removeItem(as(stranger), { id: added.item!.id }),
      'CART_ITEM_NOT_FOUND',
    );
  });

  it('empties only the dead rows on 清空失效商品', async () => {
    const userId = await makeUser();
    const live = await makeProduct();
    const dead = await makeProduct();
    await cart.addItem(as(userId), { skuId: String(live.skuId), quantity: 1 });
    await cart.addItem(as(userId), { skuId: String(dead.skuId), quantity: 1 });
    await harness.ctx.db
      .update(products)
      .set({ deletedAt: harness.clock.now() })
      .where(eq(products.id, dead.productId));

    const result = await cart.removeItems(as(userId), { itemIds: [], unavailableOnly: true });

    expect(result.removed).toBe(1);
    expect(result.cart.items).toBe(1);
  });

  it('ticks every sellable row and no dead one', async () => {
    const userId = await makeUser();
    const live = await makeProduct();
    const dead = await makeProduct();
    await cart.addItem(as(userId), { skuId: String(live.skuId), quantity: 1 });
    const deadRow = await cart.addItem(as(userId), { skuId: String(dead.skuId), quantity: 1 });
    await harness.ctx.db
      .update(products)
      .set({ status: 'off_shelf' })
      .where(eq(products.id, dead.productId));
    await cart.setSelection(as(userId), { itemIds: [], all: true, isSelected: false });

    const listed = await cart.setSelection(as(userId), {
      itemIds: [],
      all: true,
      isSelected: true,
    });

    const dying = listed.items.find((row) => row.id === deadRow.item!.id);
    expect(dying?.isSelected).toBe(false);
    expect(listed.selectedQuantity).toBe(1);
  });

  it('answers a tick with every row, not a first page of 20', async () => {
    const userId = await makeUser();
    for (let index = 0; index < 21; index += 1) {
      const product = await makeProduct();
      await cart.addItem(as(userId), { skuId: String(product.skuId), quantity: 1 });
    }

    const listed = await cart.setSelection(as(userId), {
      itemIds: [],
      all: true,
      isSelected: false,
    });

    expect(listed.items).toHaveLength(21);
    expect(listed.total).toBe(21);
  });
});

describe('再次购买', () => {
  it('puts the still-sellable lines back and names the ones it skipped', async () => {
    const userId = await makeUser();
    const live = await makeProduct({ stock: 10 });
    const gone = await makeProduct({ stock: 10 });
    await cart.addItem(as(userId), { skuId: String(live.skuId), quantity: 2 });
    await cart.addItem(as(userId), { skuId: String(gone.skuId), quantity: 1 });

    const detail = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      idempotencyKey: `rebuy-${(sequence += 1).toString().padStart(8, '0')}`,
    });
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(0);

    await harness.ctx.db
      .update(products)
      .set({ status: 'off_shelf' })
      .where(eq(products.id, gone.productId));

    const result = await cart.rebuy(as(userId), { orderId: detail.id });

    expect(result.added).toBe(1);
    expect(result.skippedSkuIds).toEqual([String(gone.skuId)]);
    expect(result.cart.items).toBe(1);
  });

  it('refuses somebody else’s order', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const item = await makeProduct();
    await cart.addItem(as(owner), { skuId: String(item.skuId), quantity: 1 });
    const detail = await order.create(as(owner), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      idempotencyKey: `rebuy-${(sequence += 1).toString().padStart(8, '0')}`,
    });

    await expectDomainError(cart.rebuy(as(stranger), { orderId: detail.id }), 'ORDER_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// the race
// ---------------------------------------------------------------------------

describe('加入购物车 from several devices at once', () => {
  it('ends at the sum, in exactly one row', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ stock: 100 });

    const report = await runConcurrently(
      8,
      () => cart.addItem(racer(userId), { skuId: String(item.skuId), quantity: 1 }),
      { isWinner: (result) => result.item !== null },
    );

    expect(report.rejected).toHaveLength(0);
    const rows = await harness.ctx.db.select().from(cartItems);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantity).toBe(8);
  });

  it('never runs past the cap, whoever wins', async () => {
    const userId = await makeUser();
    const item = await makeProduct({ stock: 100, purchaseLimit: 3 });

    await runConcurrently(6, async () => {
      try {
        return await cart.addItem(racer(userId), { skuId: String(item.skuId), quantity: 1 });
      } catch (error) {
        if (DomainError.is(error)) return null;
        throw error;
      }
    });

    const rows = await harness.ctx.db.select().from(cartItems);
    expect(rows).toHaveLength(1);
    // The advisory check may lose its race; `least(quantity + n, cap)` may not.
    expect(rows[0]!.quantity).toBeLessThanOrEqual(3);
  });

  it('removes a row exactly once when two devices delete it together', async () => {
    const userId = await makeUser();
    const item = await makeProduct();
    const added = await cart.addItem(as(userId), { skuId: String(item.skuId), quantity: 1 });

    const report = await runConcurrently(
      4,
      async () => {
        try {
          await cart.removeItem(racer(userId), { id: added.item!.id });
          return { won: true };
        } catch (error) {
          if (DomainError.is(error)) return { won: false, code: error.code };
          throw error;
        }
      },
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(0);
  });
});
