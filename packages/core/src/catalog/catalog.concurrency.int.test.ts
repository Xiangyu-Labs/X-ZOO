import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { productFavorites, productReviews } from '@shop/db/schema/catalog';
import { productEvents } from '@shop/db/schema/stats';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';

import type { Ctx } from '../kernel/context';
import * as repo from './catalog.repo';
import * as service from './catalog.service';
import * as reviews from './catalog.review.service';
import { catalogStockPort } from './catalog.stock';
import * as storefront from './catalog.storefront.service';
import {
  adminActor,
  firstSkuId,
  makeAdmin,
  makeOrderLine,
  makeProduct,
  makeUser,
  userActor,
} from './catalog.fixtures.repo';
// The order domain answers `OrderFactsPort` (reviewable lines, purchase counts).
import '../order';

/**
 * One race per conditional state change in the catalog.
 *
 * `docs/conventions.md`: "Every conditional state change ships a concurrency
 * test using `runConcurrently`." The rule exists because a read-then-write bug
 * passes every sequential test ever written; the only thing that catches it is
 * N callers released on the same tick against a real PostgreSQL.
 *
 * `forkTestCtx` gives the contenders their own `Ctx` — their own transactions
 * and their own config service — so they collide on the row rather than
 * queueing behind one shared session.
 */

let harness: TestCtx;
let other: Ctx;
let adminId: number;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  adminId = await makeAdmin(harness);
  // A second operator, on its own context: two people clicking at once.
  other = forkTestCtx(harness, { actor: adminActor(await makeAdmin(harness)) });
});

const asAdmin = (): Ctx => harness.as(adminActor(adminId));

/** Alternates between the two independent contexts. */
const ctxFor = (index: number): Ctx => (index % 2 === 0 ? asAdmin() : other);

// ---------------------------------------------------------------------------
// STOCK-003 — the last unit
// ---------------------------------------------------------------------------

describe('reserving the last unit', () => {
  it('sells it exactly once, however many shoppers commit at the same instant', async () => {
    const product = await makeProduct(asAdmin(), {
      skus: [
        {
          specValues: {},
          price: '99.00',
          stock: 1,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
      ],
    });
    const skuId = await firstSkuId(harness, product.id);

    const report = await runConcurrently(
      8,
      (index) =>
        ctxFor(index).withTx((tx) =>
          catalogStockPort.reserve(tx, 1000 + index, [{ skuId, quantity: 1 }]),
        ),
      { isWinner: (failed) => failed.length === 0 },
    );

    expect(report.rejected).toEqual([]);
    expect(report.winners).toBe(1);
    expect(report.losers).toBe(7);

    const sku = await repo.findSku(harness.ctx.db, skuId);
    expect(sku!.stock).toBe(0);

    const row = await repo.findProduct(harness.ctx.db, Number(product.id));
    expect(row!.stock).toBe(0);
  });

  it('hands out exactly the stock that existed, no more', async () => {
    const product = await makeProduct(asAdmin(), {
      skus: [
        {
          specValues: {},
          price: '99.00',
          stock: 5,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
      ],
    });
    const skuId = await firstSkuId(harness, product.id);

    const report = await runConcurrently(
      12,
      (index) =>
        ctxFor(index).withTx((tx) =>
          catalogStockPort.reserve(tx, 2000 + index, [{ skuId, quantity: 1 }]),
        ),
      { isWinner: (failed) => failed.length === 0 },
    );

    expect(report.winners).toBe(5);
    expect((await repo.findSku(harness.ctx.db, skuId))!.stock).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the effects-ledger guard on commit / release
// ---------------------------------------------------------------------------

describe('a replayed stock effect', () => {
  it('moves sales once even when the ledger delivers the paid event in parallel', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);
    await harness.ctx.withTx((tx) => catalogStockPort.reserve(tx, 3001, [{ skuId, quantity: 2 }]));

    const report = await runConcurrently(6, (index) =>
      ctxFor(index).withTx((tx) => catalogStockPort.commit(tx, 3001, [{ skuId, quantity: 2 }])),
    );

    expect(report.rejected).toEqual([]);
    const sku = await repo.findSku(harness.ctx.db, skuId);
    expect(sku!.sales).toBe(2);
    expect(sku!.stock).toBe(8);
  });

  it('returns the stock once when a cancellation is retried in parallel', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);
    await harness.ctx.withTx((tx) => catalogStockPort.reserve(tx, 3002, [{ skuId, quantity: 4 }]));

    const report = await runConcurrently(6, (index) =>
      ctxFor(index).withTx((tx) => catalogStockPort.release(tx, 3002, [{ skuId, quantity: 4 }])),
    );

    expect(report.rejected).toEqual([]);
    expect((await repo.findSku(harness.ctx.db, skuId))!.stock).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// the shelf switch
// ---------------------------------------------------------------------------

describe('two operators flipping the same shelf switch', () => {
  it('lets exactly one of them make the change', async () => {
    const product = await makeProduct(asAdmin());

    const report = await runConcurrently(4, (index) =>
      service.adminProductSetStatus(ctxFor(index), { id: product.id }, { status: 'off_shelf' }),
    );

    // Whoever loses the conditional update is told the product moved under
    // them, rather than silently reporting a change that never happened.
    expect(report.fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(report.fulfilled.length + report.rejected.length).toBe(4);
    for (const reason of report.rejected) {
      expect(reason).toMatchObject({ code: 'CATALOG_PRODUCT_NOT_FOUND' });
    }

    const row = await repo.findProduct(harness.ctx.db, Number(product.id));
    expect(row!.status).toBe('off_shelf');
  });
});

describe('two operators hiding the same category', () => {
  it('lets exactly one of them make the change', async () => {
    const category = await service.adminCategoryCreate(asAdmin(), {
      parentId: null,
      name: '男装',
      sortOrder: 0,
      isVisible: true,
    });

    const report = await runConcurrently(4, (index) =>
      service.adminCategorySetVisibility(ctxFor(index), { id: category.id }, { isVisible: false }),
    );

    expect(report.fulfilled.length + report.rejected.length).toBe(4);
    for (const reason of report.rejected) {
      expect(reason).toMatchObject({ code: 'CATALOG_CATEGORY_NOT_FOUND' });
    }

    const row = await repo.findCategory(harness.ctx.db, Number(category.id));
    expect(row!.isVisible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

describe('a double-tapped 发表评价 button', () => {
  it('writes one review and refuses the rest', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);
    const userId = await makeUser(harness);
    const { orderItemId } = await makeOrderLine(harness, {
      userId,
      productId: Number(product.id),
      skuId,
    });

    const shopper = harness.as(userActor(userId));
    const otherShopper = forkTestCtx(harness, { actor: userActor(userId) });

    const report = await runConcurrently(5, (index) =>
      reviews.reviewSubmit(index % 2 === 0 ? shopper : otherShopper, {
        orderItemId: String(orderItemId),
        productScore: 5,
        serviceScore: 5,
        content: '很好',
        images: [],
      }),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(4);
    for (const reason of report.rejected) {
      expect(reason).toMatchObject({ code: 'CATALOG_REVIEW_ALREADY_WRITTEN' });
    }

    const rows = await harness.ctx.db
      .select({ id: productReviews.id })
      .from(productReviews)
      .where(eq(productReviews.orderItemId, orderItemId));
    expect(rows).toHaveLength(1);
  });
});

describe('two operators replying to the same review', () => {
  it('lets the first reply stand', async () => {
    const product = await makeProduct(asAdmin());
    const created = await reviews.adminReviewCreate(asAdmin(), {
      productId: product.id,
      authorNickname: '小明',
      productScore: 5,
      serviceScore: 5,
      images: [],
    });

    const report = await runConcurrently(4, (index) =>
      reviews.adminReviewReply(ctxFor(index), { id: created.id }, { content: `回复${index}` }),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(3);
    for (const reason of report.rejected) {
      expect(reason).toMatchObject({ code: 'CATALOG_REVIEW_ALREADY_REPLIED' });
    }
  });
});

describe('two operators submitting the same moderation batch', () => {
  it('reports the rows moved between them exactly once', async () => {
    const product = await makeProduct(asAdmin());
    const ids: string[] = [];
    for (const nickname of ['a', 'b', 'c', 'd']) {
      const created = await reviews.adminReviewCreate(asAdmin(), {
        productId: product.id,
        authorNickname: nickname,
        productScore: 5,
        serviceScore: 5,
        images: [],
      });
      ids.push(created.id);
    }

    const report = await runConcurrently(4, (index) =>
      reviews.adminReviewBatchSetStatus(ctxFor(index), { reviewIds: ids, status: 'hidden' }),
    );

    expect(report.rejected).toEqual([]);
    const totalReported = report.fulfilled.reduce((sum, r) => sum + r.updated, 0);
    expect(totalReported).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// a hot product page
// ---------------------------------------------------------------------------

describe('a promotion sending everyone to one product page', () => {
  it('serves every view while the product row is locked, and records each one', async () => {
    const product = await makeProduct(asAdmin());
    const shoppers = await Promise.all(
      Array.from({ length: 4 }, async () =>
        forkTestCtx(harness, { actor: userActor(await makeUser(harness)) }),
      ),
    );
    const VIEWS = 8;

    // Someone else holds the product row — an operator's edit, a stock
    // reservation: an `UPDATE`, so the row lock is `FOR NO KEY UPDATE` — for
    // the whole time the views arrive. A detail request that bumped
    // `products.views` would queue behind it; one that only inserts an event
    // does not (the event's foreign key takes `FOR KEY SHARE`, which an
    // update of non-key columns does not block. Only deleting the product, or
    // an explicit `FOR UPDATE`, would.)
    const holder = await harness.db.handle.pool.connect();
    let outcome: 'served' | 'queued on the row lock';
    let report: Awaited<ReturnType<typeof runConcurrently<unknown>>> | undefined;
    try {
      await holder.query('begin');
      await holder.query('update products set stock = stock where id = $1', [product.id]);
      const reads = runConcurrently(VIEWS, (index) =>
        storefront.productDetail(shoppers[index % shoppers.length]!, { id: product.id }),
      ).then((r) => {
        report = r;
        return 'served' as const;
      });
      const waited = new Promise<'queued on the row lock'>((resolve) =>
        setTimeout(() => resolve('queued on the row lock'), 5_000),
      );
      outcome = await Promise.race([reads, waited]);
    } finally {
      await holder.query('rollback');
      holder.release();
    }

    expect(outcome).toBe('served');
    expect(report!.rejected).toEqual([]);
    const views = await harness.ctx.db
      .select({ id: productEvents.id })
      .from(productEvents)
      .where(and(eq(productEvents.productId, Number(product.id)), eq(productEvents.kind, 'view')));
    expect(views).toHaveLength(VIEWS);
  });
});

// ---------------------------------------------------------------------------
// favourites
// ---------------------------------------------------------------------------

describe('a double-tapped heart', () => {
  it('leaves one favourite row', async () => {
    const product = await makeProduct(asAdmin());
    const userId = await makeUser(harness);
    const shopper = harness.as(userActor(userId));
    const otherShopper = forkTestCtx(harness, { actor: userActor(userId) });

    const report = await runConcurrently(6, (index) =>
      storefront.favoriteAdd(index % 2 === 0 ? shopper : otherShopper, { productId: product.id }),
    );

    expect(report.rejected).toEqual([]);

    const rows = await harness.ctx.db
      .select({ productId: productFavorites.productId })
      .from(productFavorites)
      .where(
        and(
          eq(productFavorites.userId, userId),
          eq(productFavorites.productId, Number(product.id)),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
