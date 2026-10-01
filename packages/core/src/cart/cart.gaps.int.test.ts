import { cartItems } from '@shop/db/schema/cart';
import { productSkus, products } from '@shop/db/schema/catalog';
import { productEvents } from '@shop/db/schema/stats';
import { users } from '@shop/db/schema/user';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { registerCatalogDomain } from '../catalog';
import * as stats from '../stats';
import * as cart from './index';

/**
 * 修改规格, against a real database.
 *
 * It is a server operation so the storefront needs no workaround that could
 * lose the shopper's row: 修改规格 as `DELETE` then `POST` from the page leaves
 * no row at all if the second call fails. What is tested here is that it is
 * *one transaction* and that its conditional statements decide the winner.
 */

let harness: TestCtx;
const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  // The cart resolves SKUs through the order domain's CatalogPort, which
  // only the catalog domain registers.
  registerCatalogDomain();
  harness = await createTestCtx({ now: NOW, platform: 'h5' });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
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
    .values({ account: `cart-gaps-${sequence}` })
    .returning({ id: users.id });
  return row!.id;
}

interface ProductOptions {
  stock?: number;
  purchaseLimit?: number;
  skus?: number;
}

/** One product with `skus` variants — 修改规格 moves between two of them. */
async function makeProduct(
  options: ProductOptions = {},
): Promise<{ productId: number; skuIds: number[] }> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      kind: 'physical',
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      unitName: '件',
      price: '60.00',
      stock: options.stock ?? 10,
      freightMode: 'free',
      purchaseLimitMode: options.purchaseLimit ? 'per_order' : 'none',
      purchaseLimitQuantity: options.purchaseLimit ?? null,
    })
    .returning({ id: products.id });

  const skuIds: number[] = [];
  for (let i = 0; i < (options.skus ?? 2); i += 1) {
    sequence += 1;
    const [sku] = await harness.ctx.db
      .insert(productSkus)
      .values({
        productId: product!.id,
        skuCode: `SKU-${sequence}`,
        specText: `规格${i + 1}`,
        price: '60.00',
        originalPrice: '88.00',
        stock: options.stock ?? 10,
        isDefault: i === 0,
      })
      .returning({ id: productSkus.id });
    skuIds.push(sku!.id);
  }
  return { productId: product!.id, skuIds };
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
// 修改规格
// ---------------------------------------------------------------------------

describe('changing a row’s SKU', () => {
  it('moves the units onto the new variant and leaves exactly one row', async () => {
    const userId = await makeUser();
    const { skuIds } = await makeProduct();
    const added = await cart.addItem(as(userId), { skuId: String(skuIds[0]!), quantity: 2 });

    const result = await cart.updateItem(
      as(userId),
      { id: added.item!.id },
      {
        skuId: String(skuIds[1]!),
      },
    );

    expect(result.item).toMatchObject({ skuId: String(skuIds[1]), quantity: 2 });
    expect(result.cart).toMatchObject({ items: 1, quantity: 2 });
    const rows = await harness.ctx.db.select().from(cartItems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.skuId).toBe(skuIds[1]);
  });

  it('folds into a row that already holds the new variant, and answers with the survivor', async () => {
    const userId = await makeUser();
    const { skuIds } = await makeProduct();
    const moving = await cart.addItem(as(userId), { skuId: String(skuIds[0]!), quantity: 2 });
    const target = await cart.addItem(as(userId), { skuId: String(skuIds[1]!), quantity: 1 });

    const result = await cart.updateItem(
      as(userId),
      { id: moving.item!.id },
      {
        skuId: String(skuIds[1]!),
      },
    );

    // 2 + 1, one row, and the id that comes back is the target's, not the one
    // that was PATCHed.
    expect(result.item).toMatchObject({ id: target.item!.id, quantity: 3 });
    expect(result.cart).toMatchObject({ items: 1, quantity: 3 });
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(1);
  });

  it('re-checks the purchase limit against the merged total, not the moved units', async () => {
    const userId = await makeUser();
    const { skuIds } = await makeProduct({ purchaseLimit: 3 });
    const moving = await cart.addItem(as(userId), { skuId: String(skuIds[0]!), quantity: 2 });
    await cart.addItem(as(userId), { skuId: String(skuIds[1]!), quantity: 2 });

    // 2 moved onto 2 already there is 4, past the limit of 3 — even though
    // neither row on its own breaks it.
    await expectDomainError(
      cart.updateItem(as(userId), { id: moving.item!.id }, { skuId: String(skuIds[1]!) }),
      'CART_PURCHASE_LIMIT_REACHED',
    );
    const rows = await harness.ctx.db.select().from(cartItems);
    expect(rows).toHaveLength(2);
  });

  it('re-checks stock on the new variant', async () => {
    const userId = await makeUser();
    const { productId, skuIds } = await makeProduct({ stock: 5 });
    const added = await cart.addItem(as(userId), { skuId: String(skuIds[0]!), quantity: 4 });
    await harness.ctx.db
      .update(productSkus)
      .set({ stock: 1 })
      .where(eq(productSkus.id, skuIds[1]!));
    await harness.ctx.db.update(products).set({ stock: 6 }).where(eq(products.id, productId));

    await expectDomainError(
      cart.updateItem(as(userId), { id: added.item!.id }, { skuId: String(skuIds[1]!) }),
      'CART_OUT_OF_STOCK',
    );
    // The old row is still there: nothing was lost on the way.
    const rows = await harness.ctx.db.select().from(cartItems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.skuId).toBe(skuIds[0]);
  });

  it('refuses a variant that is not for sale, without touching the row', async () => {
    const userId = await makeUser();
    const live = await makeProduct();
    const dead = await makeProduct({ skus: 1 });
    const added = await cart.addItem(as(userId), { skuId: String(live.skuIds[0]!), quantity: 1 });
    await harness.ctx.db
      .update(products)
      .set({ status: 'off_shelf' })
      .where(eq(products.id, dead.productId));

    await expectDomainError(
      cart.updateItem(as(userId), { id: added.item!.id }, { skuId: String(dead.skuIds[0]!) }),
      'CART_SKU_NOT_AVAILABLE',
    );
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(1);
  });

  it('takes a new quantity in the same call', async () => {
    const userId = await makeUser();
    const { skuIds } = await makeProduct();
    const added = await cart.addItem(as(userId), { skuId: String(skuIds[0]!), quantity: 2 });

    const result = await cart.updateItem(
      as(userId),
      { id: added.item!.id },
      {
        skuId: String(skuIds[1]!),
        quantity: 5,
      },
    );
    expect(result.item).toMatchObject({ skuId: String(skuIds[1]), quantity: 5 });
  });

  it('is a no-op change when the SKU is the one the row already holds', async () => {
    const userId = await makeUser();
    const { skuIds } = await makeProduct();
    const added = await cart.addItem(as(userId), { skuId: String(skuIds[0]!), quantity: 2 });

    const result = await cart.updateItem(
      as(userId),
      { id: added.item!.id },
      {
        skuId: String(skuIds[0]!),
        quantity: 3,
      },
    );
    // Same id, so the row kept its place in the list.
    expect(result.item).toMatchObject({ id: added.item!.id, quantity: 3 });
  });

  it('two devices re-speccing the same row: one moves it, the other is told it is gone', async () => {
    const userId = await makeUser();
    const { skuIds } = await makeProduct({ skus: 3, stock: 50 });
    const added = await cart.addItem(as(userId), { skuId: String(skuIds[0]!), quantity: 2 });

    const report = await runConcurrently(
      4,
      async (index) => {
        try {
          await cart.updateItem(
            racer(userId),
            { id: added.item!.id },
            {
              skuId: String(skuIds[1 + (index % 2)]!),
            },
          );
          return { won: true };
        } catch (error) {
          if (DomainError.is(error)) return { won: false, code: error.code };
          throw error;
        }
      },
      { isWinner: (outcome) => outcome.won },
    );

    expect(report.winners).toBe(1);
    expect(report.losers).toBe(3);
    // The units were moved once, not four times.
    const rows = await harness.ctx.db.select().from(cartItems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(2);
    expect(rows[0]!.skuId).not.toBe(skuIds[0]);
  });
});

// ---------------------------------------------------------------------------
// 加购件数
// ---------------------------------------------------------------------------

/**
 * `product_events.created_at` is `defaultNow()`, so a row written by the cart
 * carries the database's wall clock, not the harness clock. The window is
 * therefore built around the real instant rather than around `NOW`.
 *
 * Wide enough (three days) that a test running across a Shanghai midnight still
 * brackets the row, and narrow enough to stay inside `MAX_RANGE_DAYS`.
 */
function windowAroundNow(): { from: string; to: string } {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  return {
    from: new Date(now - day).toISOString(),
    to: new Date(now + day).toISOString(),
  };
}

const cartQuantityOf = async (): Promise<number> => {
  // `productStats` memoises the whole page in Redis, so a test that reads the
  // tile before and after an add has to drop the cache in between.
  await harness.redis.flushdb();
  const page = await stats.productStats(harness.ctx, windowAroundNow());
  const tile = page.metrics.find((metric) => metric.key === 'cartQuantity');
  if (tile === undefined) throw new Error('no 加购件数 tile');
  return tile.value;
};

describe('加购件数', () => {
  it('reports the units the shopper just added', async () => {
    const userId = await makeUser();
    const { productId, skuIds } = await makeProduct();

    expect(await cartQuantityOf()).toBe(0);
    await cart.addItem(as(userId), { skuId: String(skuIds[0]!), quantity: 1 });
    expect(await cartQuantityOf()).toBe(1);

    // Per product, which is the column stats draws on 商品排行.
    const ranking = await stats.productRanking(harness.ctx, {
      ...windowAroundNow(),
      sortBy: 'cartQuantity',
      limit: 20,
    });
    const row = ranking.rows.find((candidate) => candidate.productId === String(productId));
    expect(row?.cartQuantity).toBe(1);
  });

  it('sums units rather than counting taps, and records the variant', async () => {
    const userId = await makeUser();
    const { productId, skuIds } = await makeProduct();

    await cart.addItem(as(userId), { skuId: String(skuIds[0]!), quantity: 2 });
    await cart.addItem(as(userId), { skuId: String(skuIds[0]!), quantity: 3 });
    await cart.addItem(as(userId), { skuId: String(skuIds[1]!), quantity: 1 });

    // One cart row of five units plus one of one — but six units of interest.
    expect(await cartQuantityOf()).toBe(6);

    const events = await harness.ctx.db
      .select()
      .from(productEvents)
      .where(eq(productEvents.kind, 'cart'));
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.quantity)).toEqual([2, 3, 1]);
    expect(events.map((event) => event.skuId)).toEqual([skuIds[0], skuIds[0], skuIds[1]]);
    expect(new Set(events.map((event) => event.productId))).toEqual(new Set([productId]));
    // The harness ctx is `platform: 'h5'`, mapped from `X-Client-Platform`.
    expect(events.every((event) => event.platform === 'h5')).toBe(true);
  });

  it('is not written when the add is refused', async () => {
    const userId = await makeUser();
    const { skuIds } = await makeProduct({ stock: 1 });

    await expectDomainError(
      cart.addItem(as(userId), { skuId: String(skuIds[0]!), quantity: 5 }),
      'CART_OUT_OF_STOCK',
    );
    expect(await cartQuantityOf()).toBe(0);
    expect(
      await harness.ctx.db.select().from(productEvents).where(eq(productEvents.kind, 'cart')),
    ).toHaveLength(0);
  });
});
