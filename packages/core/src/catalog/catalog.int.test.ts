import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { productReviews, productSkus, productVirtualCards } from '@shop/db/schema/catalog';
import { productEvents } from '@shop/db/schema/stats';
import { attachments } from '@shop/db/schema/storage';
import { effects as effectsTable } from '@shop/db/schema/system';
import { createTestCtx, type TestCtx } from '@shop/testing';

import { DomainError } from '../kernel/errors';
import type { Ctx } from '../kernel/context';
import { registerNotificationDomain } from '../notification';
import { catalogConfig } from './catalog.config';
import * as repo from './catalog.repo';
import * as service from './catalog.service';
import * as reviews from './catalog.review.service';
import { catalogStockPort } from './catalog.stock';
import { foldProductViews, VIEW_WATERMARK_KEY } from './catalog.views';
import * as storefront from './catalog.storefront.service';
import * as taxonomy from './catalog.taxonomy.service';
import { catalogPermissions } from './permissions';
import {
  adminActor,
  firstSkuId,
  makeAdmin,
  makeCategory,
  makeOrderLine,
  makeProduct,
  makeUser,
  productForm,
  userActor,
} from './catalog.fixtures.repo';
// The order domain answers `OrderFactsPort` (reviewable lines, purchase counts).
import '../order';

/**
 * The catalog against a real PostgreSQL 17.
 *
 * Everything here needs the database to mean anything: the CHECK constraints,
 * the unique indexes (`product_skus_spec_uq`, `product_reviews_order_item_uq`,
 * `product_virtual_cards_order_item_uq`), the `ilike` search over real Chinese
 * text, and every `conditionalUpdate` whose answer is a row count. The races
 * live next door in `catalog.concurrency.int.test.ts`.
 */

let harness: TestCtx;
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
  // `truncateAll` empties the settings table but not the config cache, so a
  // 库存预警值 set by one test would answer `get` in the next one — and `set`
  // itself reads through that cache, so a stale value equal to the new one
  // makes the write a no-op and leaves the group on its defaults.
  await harness.ctx.config.invalidate(catalogConfig.group);
  harness.clock.set(NOW);
  // `notify` drops an event nobody registered rather than failing the order it
  // belongs to — which is right, and would also let 库存预警 assertions pass
  // while proving nothing. Registration is idempotent.
  registerNotificationDomain();
  adminId = await makeAdmin(harness);
});

const asAdmin = (): Ctx => harness.as(adminActor(adminId));
const asUser = (id: number): Ctx => harness.as(userActor(id));

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

describe('categories', () => {
  it('materialises the path and the level from the parent', async () => {
    const root = await service.adminCategoryCreate(asAdmin(), {
      parentId: null,
      name: '男装',
      sortOrder: 0,
      isVisible: true,
    });
    const child = await service.adminCategoryCreate(asAdmin(), {
      parentId: root.id,
      name: 'T恤',
      sortOrder: 0,
      isVisible: true,
    });

    expect(root.path).toBe('/');
    expect(root.level).toBe(0);
    expect(child.path).toBe(`/${root.id}/`);
    expect(child.level).toBe(1);
  });

  it('refuses a fourth level', async () => {
    const a = await service.adminCategoryCreate(asAdmin(), {
      parentId: null,
      name: 'a',
      sortOrder: 0,
      isVisible: true,
    });
    const b = await service.adminCategoryCreate(asAdmin(), {
      parentId: a.id,
      name: 'b',
      sortOrder: 0,
      isVisible: true,
    });
    const c = await service.adminCategoryCreate(asAdmin(), {
      parentId: b.id,
      name: 'c',
      sortOrder: 0,
      isVisible: true,
    });

    await expect(
      service.adminCategoryCreate(asAdmin(), {
        parentId: c.id,
        name: 'd',
        sortOrder: 0,
        isVisible: true,
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_CATEGORY_TOO_DEEP' });
  });

  it('rewrites the whole subtree when a branch moves', async () => {
    const a = await service.adminCategoryCreate(asAdmin(), {
      parentId: null,
      name: 'a',
      sortOrder: 0,
      isVisible: true,
    });
    const b = await service.adminCategoryCreate(asAdmin(), {
      parentId: null,
      name: 'b',
      sortOrder: 0,
      isVisible: true,
    });
    const child = await service.adminCategoryCreate(asAdmin(), {
      parentId: a.id,
      name: 'child',
      sortOrder: 0,
      isVisible: true,
    });
    const grandchild = await service.adminCategoryCreate(asAdmin(), {
      parentId: child.id,
      name: 'grandchild',
      sortOrder: 0,
      isVisible: true,
    });

    await service.adminCategoryUpdate(
      asAdmin(),
      { id: child.id },
      { parentId: b.id, name: 'child', sortOrder: 0, isVisible: true },
    );

    const moved = await service.adminCategoryDetail(asAdmin(), { id: grandchild.id });
    expect(moved.path).toBe(`/${b.id}/${child.id}/`);
    expect(moved.level).toBe(2);
  });

  it('refuses to make a category a child of its own descendant', async () => {
    const a = await service.adminCategoryCreate(asAdmin(), {
      parentId: null,
      name: 'a',
      sortOrder: 0,
      isVisible: true,
    });
    const child = await service.adminCategoryCreate(asAdmin(), {
      parentId: a.id,
      name: 'child',
      sortOrder: 0,
      isVisible: true,
    });

    await expect(
      service.adminCategoryUpdate(
        asAdmin(),
        { id: a.id },
        { parentId: child.id, name: 'a', sortOrder: 0, isVisible: true },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_CATEGORY_CYCLE' });
  });

  it('refuses to delete a category that still holds products', async () => {
    const categoryId = await makeCategory(asAdmin());
    await makeProduct(asAdmin(), { categoryIds: [categoryId] });

    await expect(service.adminCategoryDelete(asAdmin(), { id: categoryId })).rejects.toMatchObject({
      code: 'CATALOG_CATEGORY_IN_USE',
    });
  });

  it('moves the storefront tree version whenever the tree changes', async () => {
    const before = await storefront.categoryTree(harness.ctx);
    harness.clock.set('2026-06-02T00:00:00.000Z');
    await makeCategory(asAdmin(), '新类目');
    const after = await storefront.categoryTree(harness.ctx);

    expect(after.version).not.toBe(before.version);
  });

  it('keeps an invisible category out of the storefront tree', async () => {
    const id = await makeCategory(asAdmin(), '内部类目');
    await service.adminCategorySetVisibility(asAdmin(), { id }, { isVisible: false });

    const tree = await storefront.categoryTree(harness.ctx);
    expect(tree.items.map((i) => i.id)).not.toContain(id);
  });

  it('moves the tree version when a category is hidden, not only when one is added', async () => {
    const id = await makeCategory(asAdmin(), '待隐藏类目');
    const before = (await storefront.categoryTree(harness.ctx)).version;

    harness.clock.set('2026-06-03T00:00:00.000Z');
    await service.adminCategorySetVisibility(asAdmin(), { id }, { isVisible: false });
    const after = (await storefront.categoryTree(harness.ctx)).version;

    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// products and SKUs
// ---------------------------------------------------------------------------

describe('products', () => {
  it('CMS-001 — sanitises the description on save, and a re-save changes nothing', async () => {
    const product = await makeProduct(asAdmin(), {
      descriptionHtml:
        '<p onclick="alert(1)">面料 &amp; 洗涤</p><script>alert(1)</script>' +
        '<img src="/uploads/a.png" onerror="alert(1)" /><a href="javascript:alert(1)">链接</a>',
    });
    const stored = (await service.adminProductDetail(asAdmin(), { id: product.id }))
      .descriptionHtml;
    expect(stored).toBe('<p>面料 &amp; 洗涤</p><img src="/uploads/a.png" /><a>链接</a>');

    await service.adminProductUpdate(
      asAdmin(),
      { id: product.id },
      productForm({ name: product.name, descriptionHtml: stored }),
    );
    expect((await service.adminProductDetail(asAdmin(), { id: product.id })).descriptionHtml).toBe(
      stored,
    );
  });

  it('rolls the denormalised price and stock up from the visible SKUs', async () => {
    const product = await makeProduct(asAdmin(), {
      specMode: true,
      specs: [{ name: '尺码', values: [{ value: 'M' }, { value: 'L' }] }],
      skus: [
        {
          specValues: { 尺码: 'M' },
          price: '99.00',
          stock: 3,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
        {
          specValues: { 尺码: 'L' },
          price: '79.00',
          stock: 5,
          isDefault: false,
          isVisible: true,
          sortOrder: 1,
        },
      ],
    });

    expect(product.price).toBe('79.00');
    expect(product.stock).toBe(8);
  });

  it('excludes an invisible SKU from the price and the stock', async () => {
    const product = await makeProduct(asAdmin(), {
      specMode: true,
      specs: [{ name: '尺码', values: [{ value: 'M' }, { value: 'L' }] }],
      skus: [
        {
          specValues: { 尺码: 'M' },
          price: '99.00',
          stock: 3,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
        {
          specValues: { 尺码: 'L' },
          price: '1.00',
          stock: 100,
          isDefault: false,
          isVisible: false,
          sortOrder: 1,
        },
      ],
    });

    expect(product.price).toBe('99.00');
    expect(product.stock).toBe(3);
  });

  it('keeps a SKU id, its stock and its sales when the price is edited', async () => {
    const product = await makeProduct(asAdmin(), {
      specMode: true,
      specs: [{ name: '尺码', values: [{ value: 'M' }] }],
      skus: [
        {
          specValues: { 尺码: 'M' },
          price: '99.00',
          stock: 10,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
      ],
    });
    const skuId = Number(product.skus[0]!.id);
    await harness.ctx.db.update(productSkus).set({ sales: 4 }).where(eq(productSkus.id, skuId));

    const edited = await service.adminProductUpdate(
      asAdmin(),
      { id: product.id },
      productForm({
        name: product.name,
        categoryIds: product.categoryIds,
        specMode: true,
        specs: [{ name: '尺码', values: [{ value: 'M' }] }],
        skus: [
          {
            specValues: { 尺码: 'M' },
            price: '89.00',
            stock: 10,
            isDefault: true,
            isVisible: true,
            sortOrder: 0,
          },
        ],
      }),
    );

    expect(edited.skus).toHaveLength(1);
    expect(Number(edited.skus[0]!.id)).toBe(skuId);
    expect(edited.skus[0]!.price).toBe('89.00');
    expect(edited.skus[0]!.sales).toBe(4);
  });

  describe('editing while orders move the stock', () => {
    const sizes = (skus: Array<{ value: string; stock: number; expectedStock?: number }>) =>
      productForm({
        specMode: true,
        specs: [{ name: '尺码', values: skus.map((s) => ({ value: s.value })) }],
        skus: skus.map((s, index) => ({
          specValues: { 尺码: s.value },
          price: '99.00',
          stock: s.stock,
          ...(s.expectedStock === undefined ? {} : { expectedStock: s.expectedStock }),
          isDefault: index === 0,
          isVisible: true,
          sortOrder: index,
        })),
      });

    async function soldThree() {
      const product = await makeProduct(asAdmin(), sizes([{ value: 'M', stock: 10 }]));
      const skuId = Number(product.skus[0]!.id);
      // The editor is open showing 10; meanwhile an order takes 3.
      await harness.ctx.withTx((tx) => catalogStockPort.reserve(tx, 1, [{ skuId, quantity: 3 }]));
      return { product, skuId };
    }

    it('leaves an untouched stock alone rather than writing the stale number back', async () => {
      const { product, skuId } = await soldThree();
      const edited = await service.adminProductUpdate(
        asAdmin(),
        { id: product.id },
        {
          ...sizes([{ value: 'M', stock: 10, expectedStock: 10 }]),
          name: '改了名字',
          categoryIds: product.categoryIds,
        },
      );
      expect(edited.name).toBe('改了名字');
      expect((await repo.findSku(harness.ctx.db, skuId))!.stock).toBe(7);
    });

    it('refuses a changed stock when orders moved it since the form was opened', async () => {
      const { product, skuId } = await soldThree();
      await expect(
        service.adminProductUpdate(
          asAdmin(),
          { id: product.id },
          {
            ...sizes([{ value: 'M', stock: 50, expectedStock: 10 }]),
            categoryIds: product.categoryIds,
          },
        ),
      ).rejects.toMatchObject({
        code: 'CATALOG_SKU_STOCK_CHANGED',
        details: { expected: 10, current: 7 },
      });
      expect((await repo.findSku(harness.ctx.db, skuId))!.stock).toBe(7);
    });

    it('writes a changed stock over the number the operator saw', async () => {
      const { product, skuId } = await soldThree();
      await service.adminProductUpdate(
        asAdmin(),
        { id: product.id },
        {
          ...sizes([{ value: 'M', stock: 50, expectedStock: 7 }]),
          categoryIds: product.categoryIds,
        },
      );
      expect((await repo.findSku(harness.ctx.db, skuId))!.stock).toBe(50);
    });
  });

  it('refuses to drop a spec combination somebody bought, instead of a 500', async () => {
    const product = await makeProduct(
      asAdmin(),
      productForm({
        specMode: true,
        specs: [{ name: '尺码', values: [{ value: 'M' }, { value: 'XL' }] }],
        skus: ['M', 'XL'].map((value, index) => ({
          specValues: { 尺码: value },
          price: '99.00',
          stock: 5,
          isDefault: index === 0,
          isVisible: true,
          sortOrder: index,
        })),
      }),
    );
    const xl = product.skus.find((sku) => sku.specValues['尺码'] === 'XL')!;
    await makeOrderLine(harness, {
      userId: await makeUser(harness),
      productId: Number(product.id),
      skuId: Number(xl.id),
      status: 'received',
    });

    await expect(
      service.adminProductUpdate(
        asAdmin(),
        { id: product.id },
        productForm({
          categoryIds: product.categoryIds,
          specMode: true,
          specs: [{ name: '尺码', values: [{ value: 'M' }] }],
          skus: [
            {
              specValues: { 尺码: 'M' },
              price: '99.00',
              stock: 5,
              isDefault: true,
              isVisible: true,
              sortOrder: 0,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_SKU_IN_USE' });
  });

  it('refuses a duplicate SPU', async () => {
    await makeProduct(asAdmin(), { spu: 'SPU-1' });
    await expect(makeProduct(asAdmin(), { spu: 'SPU-1' })).rejects.toMatchObject({
      code: 'CATALOG_PRODUCT_SPU_TAKEN',
    });
  });

  it('refuses a product filed under a category that does not exist', async () => {
    await expect(
      service.adminProductCreate(asAdmin(), productForm({ categoryIds: ['999999'] })),
    ).rejects.toMatchObject({ code: 'CATALOG_CATEGORY_NOT_FOUND' });
  });

  it('restores a deleted product as off_shelf, never straight back on sale', async () => {
    const product = await makeProduct(asAdmin());
    await service.adminProductDelete(asAdmin(), { id: product.id });

    const restored = await service.adminProductRestore(asAdmin(), { id: product.id });
    expect(restored.status).toBe('off_shelf');
  });

  it('refuses to restore a product that was never deleted', async () => {
    const product = await makeProduct(asAdmin());
    await expect(service.adminProductRestore(asAdmin(), { id: product.id })).rejects.toMatchObject({
      code: 'CATALOG_PRODUCT_NOT_DELETED',
    });
  });

  it('refuses to delete a product an unfinished order still references', async () => {
    const userId = await makeUser(harness);
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);
    await makeOrderLine(harness, {
      userId,
      productId: Number(product.id),
      skuId,
      status: 'received',
    });

    await expect(service.adminProductDelete(asAdmin(), { id: product.id })).rejects.toMatchObject({
      code: 'CATALOG_PRODUCT_IN_USE',
    });
  });

  it('lists the SKUs below the warning threshold', async () => {
    await makeProduct(asAdmin(), {
      skus: [
        {
          specValues: {},
          price: '99.00',
          stock: 2,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
      ],
    });
    // The default fixture stock is 10, which *is* the threshold and therefore
    // already a warning; this one is comfortably above it.
    await makeProduct(asAdmin(), {
      skus: [
        {
          specValues: {},
          price: '99.00',
          stock: 500,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
      ],
    });

    const warnings = await service.adminStockWarnings(asAdmin(), { page: 1, pageSize: 20 });
    expect(warnings.total).toBe(1);
    expect(warnings.items[0]!.stock).toBe(2);
    expect(warnings.items[0]!.threshold).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// the shelf switch
// ---------------------------------------------------------------------------

describe('taking a product off the shelf', () => {
  it('removes it from the storefront list', async () => {
    const product = await makeProduct(asAdmin());
    const before = await storefront.productList(harness.ctx, { page: 1, pageSize: 20 });
    expect(before.items.map((i) => i.id)).toContain(product.id);

    await service.adminProductSetStatus(asAdmin(), { id: product.id }, { status: 'off_shelf' });

    const after = await storefront.productList(harness.ctx, { page: 1, pageSize: 20 });
    expect(after.items.map((i) => i.id)).not.toContain(product.id);
    expect(after.total).toBe(0);
  });

  it('makes the product page a 404', async () => {
    const product = await makeProduct(asAdmin());
    await service.adminProductSetStatus(asAdmin(), { id: product.id }, { status: 'off_shelf' });

    await expect(storefront.productDetail(harness.ctx, { id: product.id })).rejects.toMatchObject({
      code: 'CATALOG_PRODUCT_NOT_FOUND',
    });
  });

  it('refuses the sale', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    await expect(service.getSkuForSale(harness.ctx, skuId)).resolves.toMatchObject({ skuId });

    await service.adminProductSetStatus(asAdmin(), { id: product.id }, { status: 'off_shelf' });

    await expect(service.getSkuForSale(harness.ctx, skuId)).rejects.toMatchObject({
      code: 'CATALOG_PRODUCT_NOT_ON_SALE',
    });
  });

  it('refuses a new line even inside the order transaction', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);
    const userId = await makeUser(harness);
    await service.adminProductSetStatus(asAdmin(), { id: product.id }, { status: 'off_shelf' });

    await expect(
      harness.ctx.withTx((tx) =>
        service.checkPurchaseAllowance(tx, harness.ctx, { userId, skuId, quantity: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_PRODUCT_NOT_ON_SALE' });
  });

  it('hides it from search', async () => {
    const product = await makeProduct(asAdmin(), { name: '经典白T恤' });
    const found = await storefront.productList(harness.ctx, {
      page: 1,
      pageSize: 20,
      keyword: '白T恤',
    });
    expect(found.total).toBe(1);

    await service.adminProductSetStatus(asAdmin(), { id: product.id }, { status: 'off_shelf' });

    const gone = await storefront.productList(harness.ctx, {
      page: 1,
      pageSize: 20,
      keyword: '白T恤',
    });
    expect(gone.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// stock
// ---------------------------------------------------------------------------

describe('stock', () => {
  it('reserves, and reports the line it could not satisfy', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    const ok = await harness.ctx.withTx((tx) =>
      catalogStockPort.reserve(tx, 1, [{ skuId, quantity: 10 }]),
    );
    expect(ok).toEqual([]);

    const sku = await repo.findSku(harness.ctx.db, skuId);
    expect(sku!.stock).toBe(0);

    const failed = await harness.ctx.withTx((tx) =>
      catalogStockPort.reserve(tx, 2, [{ skuId, quantity: 1 }]),
    );
    expect(failed).toEqual([{ skuId, quantity: 1 }]);
  });

  it('merges two cart rows of the same SKU into one decrement', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    const failed = await harness.ctx.withTx((tx) =>
      catalogStockPort.reserve(tx, 3, [
        { skuId, quantity: 6 },
        { skuId, quantity: 6 },
      ]),
    );
    expect(failed).toEqual([{ skuId, quantity: 12 }]);
  });

  it('rolls the product stock down with the SKU', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    await harness.ctx.withTx((tx) => catalogStockPort.reserve(tx, 4, [{ skuId, quantity: 4 }]));

    const row = await repo.findProduct(harness.ctx.db, Number(product.id));
    expect(row!.stock).toBe(6);
  });

  it('commits a sale without touching stock, and only once per order', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    await harness.ctx.withTx((tx) => catalogStockPort.reserve(tx, 7, [{ skuId, quantity: 2 }]));
    await harness.ctx.withTx((tx) => catalogStockPort.commit(tx, 7, [{ skuId, quantity: 2 }]));
    // The effect ledger delivers at least once; a replay must change nothing.
    await harness.ctx.withTx((tx) => catalogStockPort.commit(tx, 7, [{ skuId, quantity: 2 }]));

    const sku = await repo.findSku(harness.ctx.db, skuId);
    expect(sku!.stock).toBe(8);
    expect(sku!.sales).toBe(2);
  });

  it('releases a cancellation without moving sales', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    await harness.ctx.withTx((tx) => catalogStockPort.reserve(tx, 8, [{ skuId, quantity: 3 }]));
    await harness.ctx.withTx((tx) => catalogStockPort.release(tx, 8, [{ skuId, quantity: 3 }]));
    await harness.ctx.withTx((tx) => catalogStockPort.release(tx, 8, [{ skuId, quantity: 3 }]));

    const sku = await repo.findSku(harness.ctx.db, skuId);
    expect(sku!.stock).toBe(10);
    expect(sku!.sales).toBe(0);
  });

  it('a committed release restores the stock and takes the sale back, in one move', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    await harness.ctx.withTx((tx) => catalogStockPort.reserve(tx, 9, [{ skuId, quantity: 3 }]));
    await harness.ctx.withTx((tx) => catalogStockPort.commit(tx, 9, [{ skuId, quantity: 3 }]));
    await harness.ctx.withTx((tx) =>
      catalogStockPort.release(tx, 9, [{ skuId, quantity: 3 }], {
        committed: true,
        refundId: 900,
      }),
    );

    const sku = await repo.findSku(harness.ctx.db, skuId);
    expect(sku!.stock).toBe(10);
    expect(sku!.sales).toBe(0);
  });

  it('restocks both partial refunds of one order, and neither of them twice', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    await harness.ctx.withTx((tx) => catalogStockPort.reserve(tx, 12, [{ skuId, quantity: 6 }]));
    await harness.ctx.withTx((tx) => catalogStockPort.commit(tx, 12, [{ skuId, quantity: 6 }]));

    // An order is refunded line by line. Keying the ledger on the order alone
    // would swallow the second refund and leave four units off the shelf for
    // good.
    await harness.ctx.withTx((tx) =>
      catalogStockPort.release(tx, 12, [{ skuId, quantity: 2 }], {
        committed: true,
        refundId: 921,
      }),
    );
    await harness.ctx.withTx((tx) =>
      catalogStockPort.release(tx, 12, [{ skuId, quantity: 4 }], {
        committed: true,
        refundId: 922,
      }),
    );
    // The effect ledger delivers at least once; a replay of either is a no-op.
    await harness.ctx.withTx((tx) =>
      catalogStockPort.release(tx, 12, [{ skuId, quantity: 2 }], {
        committed: true,
        refundId: 921,
      }),
    );

    const sku = await repo.findSku(harness.ctx.db, skuId);
    expect(sku!.stock).toBe(10);
    expect(sku!.sales).toBe(0);
  });

  it('keeps the cancel key and the refund key apart', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    await harness.ctx.withTx((tx) => catalogStockPort.reserve(tx, 13, [{ skuId, quantity: 4 }]));
    await harness.ctx.withTx((tx) => catalogStockPort.commit(tx, 13, [{ skuId, quantity: 4 }]));
    // A refund on an order that was also, at some point, cancel-released must
    // not be mistaken for the replay of that cancel. (An empty line list still
    // claims the cancel key; a zero-quantity line is refused — STOCK-001.)
    await harness.ctx.withTx((tx) => catalogStockPort.release(tx, 13, []));
    await harness.ctx.withTx((tx) =>
      catalogStockPort.release(tx, 13, [{ skuId, quantity: 4 }], {
        committed: true,
        refundId: 931,
      }),
    );

    const sku = await repo.findSku(harness.ctx.db, skuId);
    expect(sku!.stock).toBe(10);
    expect(sku!.sales).toBe(0);
  });

  it('never lets sales go negative when a release over-reaches', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    await harness.ctx.withTx((tx) =>
      catalogStockPort.release(tx, 11, [{ skuId, quantity: 5 }], {
        committed: true,
        refundId: 911,
      }),
    );

    const sku = await repo.findSku(harness.ctx.db, skuId);
    expect(sku!.sales).toBe(0);
  });

  it('the CHECK constraint is the backstop under a raw over-decrement', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    const failure = await harness.ctx.db
      .update(productSkus)
      .set({ stock: -1 })
      .where(eq(productSkus.id, skuId))
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).not.toBeNull();
    expect((failure as { cause?: { constraint?: string } }).cause?.constraint).toBe(
      'product_skus_stock_non_negative',
    );
  });
});

// ---------------------------------------------------------------------------
// 库存预警
// ---------------------------------------------------------------------------

describe('低库存提醒', () => {
  /** The notifications recorded so far, by key. */
  async function warnings() {
    const rows = await harness.ctx.db
      .select()
      .from(effectsTable)
      .where(eq(effectsTable.scope, 'notification'));
    return rows.sort((a, b) => a.scopeId.localeCompare(b.scopeId));
  }

  async function withThreshold(threshold: number): Promise<void> {
    await harness.ctx.config.set(catalogConfig, { stockWarningThreshold: threshold });
  }

  const reserve = (skuId: number, quantity: number, orderId: number) =>
    harness.ctx.withTx((tx) =>
      catalogStockPort.reserve(tx, orderId, [{ skuId, quantity }], harness.ctx),
    );

  it('warns on the crossing, not on every decrement below the line', async () => {
    await withThreshold(3);
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    // 10 -> 5. Still above the line: nothing to say.
    await reserve(skuId, 5, 101);
    expect(await warnings()).toEqual([]);

    // 5 -> 2. This is the order that took it under.
    await reserve(skuId, 3, 102);
    const [warning] = await warnings();
    expect(warning).toMatchObject({ scope: 'notification', status: 'pending' });
    expect(warning?.scopeId).toBe(`admin_low_stock:sku:${skuId}`);
    expect(warning?.payload).toMatchObject({
      event: 'admin_low_stock',
      data: { productId: Number(product.id), productName: product.name, stock: 2, threshold: 3 },
    });

    // 2 -> 1. Low, but it was low before; an operator who is told twice stops
    // reading the badge.
    await reserve(skuId, 1, 103);
    expect(await warnings()).toHaveLength(1);
  });

  it('warns about the SKU, so a twenty-variant product says which one ran out', async () => {
    await withThreshold(3);
    const product = await makeProduct(asAdmin(), {
      specMode: true,
      specs: [{ name: '颜色', values: [{ value: '黑' }, { value: '白' }] }],
      skus: [
        {
          specValues: { 颜色: '黑' },
          price: '99.00',
          stock: 10,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
        {
          specValues: { 颜色: '白' },
          price: '99.00',
          stock: 10,
          isDefault: false,
          isVisible: true,
          sortOrder: 1,
        },
      ],
    });
    const skus = await repo.listSkus(harness.ctx.db, Number(product.id));
    const [black, white] = skus;

    await reserve(black!.id, 8, 110);
    expect((await warnings()).map((row) => row.scopeId)).toEqual([
      `admin_low_stock:sku:${black!.id}`,
    ]);
    expect(white!.stock).toBe(10);
  });

  it('records nothing when the reservation’s transaction rolls back', async () => {
    await withThreshold(3);
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    // Checkout aborts its transaction on a short line, and a 库存预警 about
    // stock that was never taken would send somebody to restock a full shelf.
    await expect(
      harness.ctx.withTx(async (tx) => {
        await catalogStockPort.reserve(tx, 120, [{ skuId, quantity: 8 }], harness.ctx);
        throw new DomainError('ORDER_OUT_OF_STOCK');
      }),
    ).rejects.toBeInstanceOf(DomainError);

    expect(await warnings()).toEqual([]);
    expect((await repo.findSku(harness.ctx.db, skuId))!.stock).toBe(10);
  });

  it('says nothing at all when 库存预警值 is 0', async () => {
    await withThreshold(0);
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    await reserve(skuId, 10, 130);
    expect(await warnings()).toEqual([]);
  });

  it('says nothing to a caller with no context — the port still reserves', async () => {
    await withThreshold(3);
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    await harness.ctx.withTx((tx) => catalogStockPort.reserve(tx, 140, [{ skuId, quantity: 8 }]));

    expect((await repo.findSku(harness.ctx.db, skuId))!.stock).toBe(2);
    expect(await warnings()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// purchase limits
// ---------------------------------------------------------------------------

describe('purchase limits', () => {
  it('refuses below the minimum', async () => {
    const product = await makeProduct(asAdmin(), { minPurchaseQuantity: 2 });
    const skuId = await firstSkuId(harness, product.id);
    const userId = await makeUser(harness);

    await expect(
      harness.ctx.withTx((tx) =>
        service.checkPurchaseAllowance(tx, harness.ctx, { userId, skuId, quantity: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_MIN_PURCHASE_NOT_MET' });
  });

  it('counts what the shopper already bought against a lifetime limit', async () => {
    const product = await makeProduct(asAdmin(), {
      purchaseLimitMode: 'lifetime',
      purchaseLimitQuantity: 1,
    });
    const skuId = await firstSkuId(harness, product.id);
    const userId = await makeUser(harness);

    await expect(
      harness.ctx.withTx((tx) =>
        service.checkPurchaseAllowance(tx, harness.ctx, { userId, skuId, quantity: 1 }),
      ),
    ).resolves.toBeUndefined();

    await makeOrderLine(harness, { userId, productId: Number(product.id), skuId });

    await expect(
      harness.ctx.withTx((tx) =>
        service.checkPurchaseAllowance(tx, harness.ctx, { userId, skuId, quantity: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_PURCHASE_LIMIT_REACHED' });
  });

  it('a per-order limit ignores history', async () => {
    const product = await makeProduct(asAdmin(), {
      purchaseLimitMode: 'per_order',
      purchaseLimitQuantity: 2,
    });
    const skuId = await firstSkuId(harness, product.id);
    const userId = await makeUser(harness);
    await makeOrderLine(harness, { userId, productId: Number(product.id), skuId });

    await expect(
      harness.ctx.withTx((tx) =>
        service.checkPurchaseAllowance(tx, harness.ctx, { userId, skuId, quantity: 2 }),
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('search', () => {
  beforeEach(async () => {
    await makeProduct(asAdmin(), { name: '经典白T恤', keyword: 'cotton tee' });
    await makeProduct(asAdmin(), { name: '纯棉长裤' });
  });

  it('matches a Chinese substring', async () => {
    const found = await storefront.productList(harness.ctx, {
      page: 1,
      pageSize: 20,
      keyword: '白T',
    });
    expect(found.total).toBe(1);
  });

  it('ignores case in the keyword field', async () => {
    const upper = await storefront.productList(harness.ctx, {
      page: 1,
      pageSize: 20,
      keyword: 'COTTON',
    });
    expect(upper.total).toBe(1);
  });

  it('treats % as a literal, not a wildcard', async () => {
    const found = await storefront.productList(harness.ctx, {
      page: 1,
      pageSize: 20,
      keyword: '%',
    });
    expect(found.total).toBe(0);
  });

  it('records the search and offers it back as a hot keyword, but not a fruitless one', async () => {
    await storefront.productList(harness.ctx, { page: 1, pageSize: 20, keyword: '白T恤' });
    await storefront.productList(harness.ctx, { page: 1, pageSize: 20, keyword: '不存在的商品' });

    const hot = await storefront.hotKeywords(harness.ctx);
    expect(hot.items.map((i) => i.keyword)).toEqual(['白T恤']);
  });

  it('keeps a per-shopper history, newest first, de-duplicated', async () => {
    const userId = await makeUser(harness);
    const ctx = asUser(userId);

    await storefront.productList(ctx, { page: 1, pageSize: 20, keyword: '白T恤' });
    harness.clock.set('2026-06-01T01:00:00.000Z');
    await storefront.productList(ctx, { page: 1, pageSize: 20, keyword: '长裤' });
    harness.clock.set('2026-06-01T02:00:00.000Z');
    await storefront.productList(ctx, { page: 1, pageSize: 20, keyword: '白T恤' });

    const history = await storefront.searchHistory(ctx);
    expect(history.items.map((i) => i.keyword)).toEqual(['白T恤', '长裤']);

    await storefront.clearSearchHistory(ctx);
    expect((await storefront.searchHistory(ctx)).items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// favourites and history
// ---------------------------------------------------------------------------

describe('favourites', () => {
  it('is idempotent and reversible', async () => {
    const product = await makeProduct(asAdmin());
    const userId = await makeUser(harness);
    const ctx = asUser(userId);

    await storefront.favoriteAdd(ctx, { productId: product.id });
    await storefront.favoriteAdd(ctx, { productId: product.id });

    const list = await storefront.favoriteList(ctx, { page: 1, pageSize: 20 });
    expect(list.total).toBe(1);

    await storefront.favoriteRemove(ctx, { productId: product.id });
    expect((await storefront.favoriteList(ctx, { page: 1, pageSize: 20 })).total).toBe(0);
  });

  it('keeps a favourite taken off the shelf on the list, marked unavailable and removable, as counted', async () => {
    const kept = await makeProduct(asAdmin());
    const gone = await makeProduct(asAdmin());
    const ctx = asUser(await makeUser(harness));
    await storefront.favoriteAdd(ctx, { productId: kept.id });
    harness.clock.set('2026-06-01T01:00:00.000Z');
    await storefront.favoriteAdd(ctx, { productId: gone.id });
    await service.adminProductSetStatus(asAdmin(), { id: gone.id }, { status: 'off_shelf' });

    // Newest first: the off-shelf one is page 1 on its own, not an empty page.
    const first = await storefront.favoriteList(ctx, { page: 1, pageSize: 1 });
    expect(first.total).toBe(2);
    expect(first.items.map((i) => i.product.id)).toEqual([gone.id]);
    expect(first.items[0]?.product).toMatchObject({ stock: 0, canAddToCart: false });
    expect(first.items[0]?.available).toBe(false);
    const second = await storefront.favoriteList(ctx, { page: 2, pageSize: 1 });
    expect(second.items[0]?.available).toBe(true);

    await storefront.favoriteRemoveBatch(ctx, { productIds: [gone.id] });
    const after = await storefront.favoriteList(ctx, { page: 1, pageSize: 20 });
    expect(after.total).toBe(1);
    expect(after.items.map((i) => i.product.id)).toEqual([kept.id]);
  });

  it('refuses to favourite something that is not on sale', async () => {
    const product = await makeProduct(asAdmin(), { status: 'off_shelf' });
    const ctx = asUser(await makeUser(harness));

    await expect(storefront.favoriteAdd(ctx, { productId: product.id })).rejects.toMatchObject({
      code: 'CATALOG_PRODUCT_NOT_FOUND',
    });
  });
});

describe('browse history', () => {
  it('collapses repeat views of the same product onto its newest visit', async () => {
    const first = await makeProduct(asAdmin());
    const second = await makeProduct(asAdmin());
    const ctx = asUser(await makeUser(harness));

    await storefront.productDetail(ctx, { id: first.id });
    harness.clock.set('2026-06-01T01:00:00.000Z');
    await storefront.productDetail(ctx, { id: second.id });
    harness.clock.set('2026-06-01T02:00:00.000Z');
    await storefront.productDetail(ctx, { id: first.id });

    const history = await storefront.historyList(ctx, { page: 1, pageSize: 20 });
    expect(history.total).toBe(2);
    expect(history.items.map((i) => i.product.id)).toEqual([first.id, second.id]);
  });

  it('lists a viewed product taken off the shelf as unavailable, so it can be removed', async () => {
    const product = await makeProduct(asAdmin());
    const ctx = asUser(await makeUser(harness));
    await storefront.productDetail(ctx, { id: product.id });
    await service.adminProductSetStatus(asAdmin(), { id: product.id }, { status: 'off_shelf' });

    const history = await storefront.historyList(ctx, { page: 1, pageSize: 20 });
    expect(history.total).toBe(1);
    expect(history.items[0]?.product).toMatchObject({ id: product.id, stock: 0 });
    expect(history.items[0]?.available).toBe(false);
    await storefront.historyRemove(ctx, { productIds: [product.id] });
    expect((await storefront.historyList(ctx, { page: 1, pageSize: 20 })).total).toBe(0);
  });

  it('prunes what falls outside the retention window', async () => {
    const product = await makeProduct(asAdmin());
    const ctx = asUser(await makeUser(harness));
    await storefront.productDetail(ctx, { id: product.id });

    harness.clock.set('2027-01-01T00:00:00.000Z');
    const { deleted } = await storefront.pruneBrowseHistory(harness.ctx);
    expect(deleted).toBeGreaterThan(0);
    expect((await storefront.historyList(ctx, { page: 1, pageSize: 20 })).total).toBe(0);
  });
});

describe('product views, folded by the worker', () => {
  // `created_at` is the database's clock, not the harness's, so the tests fold
  // with no grace period: every committed view is settled.
  const fold = (options: Parameters<typeof foldProductViews>[1] = {}) =>
    foldProductViews(harness.ctx, { graceMs: 0, ...options });
  const viewsOf = async (id: string | number) =>
    (await repo.findProduct(harness.ctx.db, Number(id)))?.views;

  beforeEach(async () => {
    await harness.redis.del(VIEW_WATERMARK_KEY);
  });

  it('records the view and leaves the product row alone on the request path', async () => {
    const product = await makeProduct(asAdmin());
    const ctx = asUser(await makeUser(harness));

    await storefront.productDetail(ctx, { id: product.id });
    await storefront.productDetail(ctx, { id: product.id });

    expect(await viewsOf(product.id)).toBe(0);
    const events = await harness.ctx.db
      .select()
      .from(productEvents)
      .where(eq(productEvents.productId, Number(product.id)));
    expect(events.filter((e) => e.kind === 'view')).toHaveLength(2);
  });

  it('folds the views recorded since the last run into products.views, once', async () => {
    const first = await makeProduct(asAdmin());
    const second = await makeProduct(asAdmin());
    const ctx = asUser(await makeUser(harness));
    // The first run after deploy only sets the watermark.
    expect(await fold()).toMatchObject({ initialised: true, views: 0 });

    for (let i = 0; i < 3; i += 1) await storefront.productDetail(ctx, { id: first.id });
    await storefront.productDetail(harness.ctx, { id: second.id });
    // A favourite is a product event too, and is not a view.
    await storefront.favoriteAdd(ctx, { productId: second.id });

    expect(await fold()).toMatchObject({ initialised: false, batches: 1, products: 2, views: 4 });
    expect(await viewsOf(first.id)).toBe(3);
    expect(await viewsOf(second.id)).toBe(1);

    // Nothing new: nothing folded twice.
    expect(await fold()).toMatchObject({ batches: 0, views: 0 });
    await storefront.productDetail(ctx, { id: second.id });
    expect(await fold()).toMatchObject({ views: 1 });
    expect(await viewsOf(first.id)).toBe(3);
    expect(await viewsOf(second.id)).toBe(2);
  });

  it('works through a backlog in batches, and a bounded run leaves the rest to the next', async () => {
    const product = await makeProduct(asAdmin());
    await fold();
    for (let i = 0; i < 7; i += 1) await storefront.productDetail(harness.ctx, { id: product.id });

    expect(await fold({ batchSize: 2, maxBatches: 2 })).toMatchObject({ batches: 2, views: 4 });
    expect(await viewsOf(product.id)).toBe(4);
    expect(await fold({ batchSize: 2 })).toMatchObject({ batches: 2, views: 3 });
    expect(await viewsOf(product.id)).toBe(7);
  });

  it('leaves views younger than the grace period for the next run', async () => {
    const product = await makeProduct(asAdmin());
    await fold();
    await storefront.productDetail(harness.ctx, { id: product.id });

    expect(await fold({ graceMs: 60_000 })).toMatchObject({ batches: 0, views: 0 });
    expect(await fold()).toMatchObject({ views: 1 });
  });

  it('never folds one range twice when two runs overlap', async () => {
    const product = await makeProduct(asAdmin());
    await fold();
    for (let i = 0; i < 6; i += 1) await storefront.productDetail(harness.ctx, { id: product.id });

    const runs = await Promise.all([fold({ batchSize: 1 }), fold({ batchSize: 1 })]);
    expect(runs[0]!.views + runs[1]!.views).toBe(6);
    expect(await viewsOf(product.id)).toBe(6);
  });

  it('starts again from the newest event when the watermark is ahead of every event', async () => {
    const product = await makeProduct(asAdmin());
    await storefront.productDetail(harness.ctx, { id: product.id });
    await harness.redis.set(VIEW_WATERMARK_KEY, '1000000');

    expect(await fold()).toMatchObject({ initialised: true, views: 0 });
    await storefront.productDetail(harness.ctx, { id: product.id });
    expect(await fold()).toMatchObject({ views: 1 });
  });
});

// ---------------------------------------------------------------------------
// virtual cards
// ---------------------------------------------------------------------------

describe('virtual cards', () => {
  async function makeCardProduct() {
    const product = await makeProduct(asAdmin(), {
      kind: 'virtual_card',
      freightMode: 'free',
      skus: [
        {
          specValues: {},
          price: '30.00',
          stock: 0,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
      ],
    });
    return { product, skuId: await firstSkuId(harness, product.id) };
  }

  it('derives the stock from the pool and reports duplicates', async () => {
    const { product, skuId } = await makeCardProduct();

    const first = await service.adminVirtualCardImport(
      asAdmin(),
      { id: product.id },
      { skuId: String(skuId), cards: [{ cardNo: 'A1' }, { cardNo: 'A2' }] },
    );
    expect(first).toMatchObject({ imported: 2, skippedCardNos: [], stock: 2 });

    const second = await service.adminVirtualCardImport(
      asAdmin(),
      { id: product.id },
      { skuId: String(skuId), cards: [{ cardNo: 'A2' }, { cardNo: 'A3' }] },
    );
    expect(second).toMatchObject({ imported: 1, skippedCardNos: ['A2'], stock: 3 });
  });

  it('saves a card product the editor echoes its pool for, and derives the stock from the pool', async () => {
    const { product, skuId } = await makeCardProduct();
    await service.adminVirtualCardImport(
      asAdmin(),
      { id: product.id },
      { skuId: String(skuId), cards: [{ cardNo: 'A1' }, { cardNo: 'A2' }] },
    );

    const edited = await service.adminProductUpdate(
      asAdmin(),
      { id: product.id },
      productForm({
        name: '改名后的充值卡',
        kind: 'virtual_card',
        freightMode: 'free',
        categoryIds: product.categoryIds,
        skus: [
          {
            specValues: {},
            price: '30.00',
            stock: 2,
            expectedStock: 2,
            isDefault: true,
            isVisible: true,
            sortOrder: 0,
          },
        ],
      }),
    );
    expect(edited).toMatchObject({ name: '改名后的充值卡', stock: 2 });
  });

  it('turns a typed stock into the (empty) pool when a product becomes a card product', async () => {
    const product = await makeProduct(asAdmin());
    expect(product.stock).toBe(10);

    const edited = await service.adminProductUpdate(
      asAdmin(),
      { id: product.id },
      productForm({
        name: product.name,
        kind: 'virtual_card',
        freightMode: 'free',
        categoryIds: product.categoryIds,
        skus: [
          {
            specValues: {},
            price: '99.00',
            stock: 10,
            expectedStock: 10,
            isDefault: true,
            isVisible: true,
            sortOrder: 0,
          },
        ],
      }),
    );
    // No cards imported yet: nothing to sell.
    expect(edited.stock).toBe(0);
    expect(edited.skus[0]!.stock).toBe(0);
  });

  it('refuses an import against a product that is not a card product', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);

    await expect(
      service.adminVirtualCardImport(
        asAdmin(),
        { id: product.id },
        { skuId: String(skuId), cards: [{ cardNo: 'A1' }] },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_NOT_A_CARD_PRODUCT' });
  });

  it('voids only unclaimed cards', async () => {
    const { product, skuId } = await makeCardProduct();
    await service.adminVirtualCardImport(
      asAdmin(),
      { id: product.id },
      { skuId: String(skuId), cards: [{ cardNo: 'A1' }, { cardNo: 'A2' }] },
    );

    const userId = await makeUser(harness);
    const { orderItemId } = await makeOrderLine(harness, {
      userId,
      productId: Number(product.id),
      skuId,
    });
    // A card already handed out — the claim itself is the order domain's
    // (`order.fulfil.repo.ts::claimVirtualCard`), so the row is set directly.
    await harness.ctx.withTx(async (tx) => {
      const [first] = await tx
        .select({ id: productVirtualCards.id })
        .from(productVirtualCards)
        .where(eq(productVirtualCards.skuId, skuId))
        .orderBy(productVirtualCards.id)
        .limit(1);
      await tx
        .update(productVirtualCards)
        .set({ state: 'claimed', orderItemId, claimedByUserId: userId, claimedAt: new Date(NOW) })
        .where(eq(productVirtualCards.id, first!.id));
      await repo.syncCardStock(tx, skuId);
    });

    const all = await harness.ctx.db
      .select({ id: productVirtualCards.id })
      .from(productVirtualCards)
      .where(eq(productVirtualCards.productId, Number(product.id)));

    const result = await service.adminVirtualCardVoid(
      asAdmin(),
      { id: product.id },
      { cardIds: all.map((c) => String(c.id)) },
    );
    expect(result.voided).toBe(1);
    expect(result.stock).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

describe('reviews', () => {
  it('lets a buyer review a delivered line exactly once', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);
    const userId = await makeUser(harness);
    const { orderItemId } = await makeOrderLine(harness, {
      userId,
      productId: Number(product.id),
      skuId,
    });
    const ctx = asUser(userId);

    const review = await reviews.reviewSubmit(ctx, {
      orderItemId: String(orderItemId),
      productScore: 5,
      serviceScore: 5,
      content: '很好',
      images: [],
    });
    expect(review.productScore).toBe(5);

    await expect(
      reviews.reviewSubmit(ctx, {
        orderItemId: String(orderItemId),
        productScore: 1,
        serviceScore: 1,
        images: [],
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_REVIEW_ALREADY_WRITTEN' });
  });

  it('refuses a line belonging to somebody else without saying why', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);
    const buyer = await makeUser(harness);
    const stranger = await makeUser(harness);
    const { orderItemId } = await makeOrderLine(harness, {
      userId: buyer,
      productId: Number(product.id),
      skuId,
    });

    await expect(
      reviews.reviewSubmit(asUser(stranger), {
        orderItemId: String(orderItemId),
        productScore: 5,
        serviceScore: 5,
        images: [],
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_REVIEW_NOT_ALLOWED' });
  });

  it('refuses a line that has not been received yet', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);
    const userId = await makeUser(harness);
    const { orderItemId } = await makeOrderLine(harness, {
      userId,
      productId: Number(product.id),
      skuId,
      status: 'shipped',
    });

    await expect(
      reviews.reviewSubmit(asUser(userId), {
        orderItemId: String(orderItemId),
        productScore: 5,
        serviceScore: 5,
        images: [],
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_REVIEW_NOT_ALLOWED' });
  });

  describe('CAT-018 — review pictures come from our own storage', () => {
    const STORED = '/uploads/review/2026/06/01/cat-018.png';

    async function reviewableLine() {
      const product = await makeProduct(asAdmin());
      const skuId = await firstSkuId(harness, product.id);
      const userId = await makeUser(harness);
      const { orderItemId } = await makeOrderLine(harness, {
        userId,
        productId: Number(product.id),
        skuId,
      });
      return { userId, orderItemId: String(orderItemId) };
    }

    it('takes a picture our uploads stored', async () => {
      await harness.ctx.db.insert(attachments).values({
        storageKey: STORED.replace(/^\/uploads\//, ''),
        driver: 'local',
        url: STORED,
        name: 'review.png',
        kind: 'image',
        mime: 'image/png',
        size: 26,
        sha256: 'c'.repeat(64),
      });
      const { userId, orderItemId } = await reviewableLine();

      const review = await reviews.reviewSubmit(asUser(userId), {
        orderItemId,
        productScore: 5,
        serviceScore: 5,
        images: [STORED],
      });
      expect(review.images).toEqual([STORED]);
    });

    it('refuses a link to somebody else’s server, and writes nothing', async () => {
      const { userId, orderItemId } = await reviewableLine();

      for (const url of [
        'https://tracker.example.net/pixel.png',
        // Our path shape, but nothing we stored.
        '/uploads/review/2026/06/01/never-uploaded.png',
      ]) {
        await expect(
          reviews.reviewSubmit(asUser(userId), {
            orderItemId,
            productScore: 5,
            serviceScore: 5,
            content: '很好',
            images: [url],
          }),
        ).rejects.toMatchObject({ code: 'CATALOG_REVIEW_IMAGE_NOT_ALLOWED' });
      }
      expect(await harness.ctx.db.select().from(productReviews)).toHaveLength(0);
    });
  });

  it('allows any number of admin-written reviews for one product', async () => {
    const product = await makeProduct(asAdmin());

    for (const nickname of ['小明', '小红', '小刚']) {
      await reviews.adminReviewCreate(asAdmin(), {
        productId: product.id,
        authorNickname: nickname,
        productScore: 5,
        serviceScore: 5,
        images: [],
      });
    }

    const list = await reviews.adminReviewList(asAdmin(), { page: 1, pageSize: 20 });
    expect(list.total).toBe(3);
  });

  it('replies once, then requires the edit route', async () => {
    const product = await makeProduct(asAdmin());
    const created = await reviews.adminReviewCreate(asAdmin(), {
      productId: product.id,
      authorNickname: '小明',
      productScore: 5,
      serviceScore: 5,
      images: [],
    });

    await reviews.adminReviewReply(asAdmin(), { id: created.id }, { content: '谢谢支持' });
    await expect(
      reviews.adminReviewReply(asAdmin(), { id: created.id }, { content: '再说一次' }),
    ).rejects.toMatchObject({ code: 'CATALOG_REVIEW_ALREADY_REPLIED' });

    const edited = await reviews.adminReviewReplyUpdate(
      asAdmin(),
      { id: created.id },
      { content: '已改口' },
    );
    expect(edited.replyContent).toBe('已改口');
  });

  it('batch moderation counts the rows it moved, not the ids it was handed', async () => {
    const product = await makeProduct(asAdmin());
    const ids: string[] = [];
    for (const nickname of ['a', 'b', 'c']) {
      const created = await reviews.adminReviewCreate(asAdmin(), {
        productId: product.id,
        authorNickname: nickname,
        productScore: 5,
        serviceScore: 5,
        images: [],
      });
      ids.push(created.id);
    }

    const first = await reviews.adminReviewBatchSetStatus(asAdmin(), {
      reviewIds: ids,
      status: 'hidden',
    });
    expect(first.updated).toBe(3);

    const again = await reviews.adminReviewBatchSetStatus(asAdmin(), {
      reviewIds: ids,
      status: 'hidden',
    });
    expect(again.updated).toBe(0);
  });

  it('summarises the published reviews and reports 100% for a product with none', async () => {
    const product = await makeProduct(asAdmin());
    const empty = await reviews.productReviewSummary(harness.ctx, { id: product.id });
    expect(empty).toMatchObject({ total: 0, averageScore: 0, goodRate: 100 });

    for (const score of [5, 4, 3, 1]) {
      await reviews.adminReviewCreate(asAdmin(), {
        productId: product.id,
        authorNickname: `u${score}`,
        productScore: score,
        serviceScore: 5,
        images: [],
      });
    }

    const summary = await reviews.productReviewSummary(harness.ctx, { id: product.id });
    expect(summary).toMatchObject({
      total: 4,
      goodCount: 2,
      mediumCount: 1,
      badCount: 1,
      averageScore: 3.3,
      goodRate: 50,
    });
  });

  it('hides a hidden review from the storefront list', async () => {
    const product = await makeProduct(asAdmin());
    const created = await reviews.adminReviewCreate(asAdmin(), {
      productId: product.id,
      authorNickname: '小明',
      productScore: 5,
      serviceScore: 5,
      images: [],
    });

    await reviews.adminReviewSetStatus(asAdmin(), { id: created.id }, { status: 'hidden' });

    const visible = await reviews.productReviews(
      harness.ctx,
      { id: product.id },
      { page: 1, pageSize: 20, rating: 'all' },
    );
    expect(visible.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the auto-review sweep
// ---------------------------------------------------------------------------

describe('auto review', () => {
  it('writes a five-star default once the window has passed, and never twice', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);
    const userId = await makeUser(harness);
    await makeOrderLine(harness, { userId, productId: Number(product.id), skuId });

    const tooEarly = await reviews.runAutoReview(harness.ctx);
    expect(tooEarly.written).toBe(0);

    harness.clock.set('2026-06-15T00:00:00.000Z');
    const first = await reviews.runAutoReview(harness.ctx);
    expect(first.written).toBe(1);

    const second = await reviews.runAutoReview(harness.ctx);
    expect(second.written).toBe(0);

    const rows = await harness.ctx.db
      .select()
      .from(productReviews)
      .where(eq(productReviews.productId, Number(product.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.productScore).toBe(5);
  });

  it('leaves a line the shopper already reviewed alone', async () => {
    const product = await makeProduct(asAdmin());
    const skuId = await firstSkuId(harness, product.id);
    const userId = await makeUser(harness);
    const { orderItemId } = await makeOrderLine(harness, {
      userId,
      productId: Number(product.id),
      skuId,
    });

    await reviews.reviewSubmit(asUser(userId), {
      orderItemId: String(orderItemId),
      productScore: 2,
      serviceScore: 2,
      content: '一般',
      images: [],
    });

    harness.clock.set('2026-06-15T00:00:00.000Z');
    const result = await reviews.runAutoReview(harness.ctx);
    expect(result.written).toBe(0);

    const rows = await harness.ctx.db
      .select()
      .from(productReviews)
      .where(eq(productReviews.productId, Number(product.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.productScore).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// taxonomy
// ---------------------------------------------------------------------------

describe('taxonomy', () => {
  it('keeps the labels when their grouping is deleted', async () => {
    const group = await taxonomy.adminLabelCategoryCreate(asAdmin(), {
      name: '促销',
      sortOrder: 0,
    });
    const label = await taxonomy.adminLabelCreate(asAdmin(), {
      categoryId: group.id,
      name: '新品',
      style: 'text',
      isVisible: true,
      isEnabled: true,
      sortOrder: 0,
    });

    await taxonomy.adminLabelCategoryDelete(asAdmin(), { id: group.id });

    const list = await taxonomy.adminLabelList(asAdmin(), { page: 1, pageSize: 20 });
    expect(list.items.map((i) => i.id)).toContain(label.id);
    expect(list.items[0]!.categoryId).toBeNull();
  });

  it('refuses a duplicate label name', async () => {
    await taxonomy.adminLabelCreate(asAdmin(), {
      categoryId: null,
      name: '新品',
      style: 'text',
      isVisible: true,
      isEnabled: true,
      sortOrder: 0,
    });
    await expect(
      taxonomy.adminLabelCreate(asAdmin(), {
        categoryId: null,
        name: '新品',
        style: 'text',
        isVisible: true,
        isEnabled: true,
        sortOrder: 0,
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_NAME_TAKEN' });
  });

  it('renders only enabled, visible labels on a product card', async () => {
    const shown = await taxonomy.adminLabelCreate(asAdmin(), {
      categoryId: null,
      name: '热卖',
      style: 'text',
      isVisible: true,
      isEnabled: true,
      sortOrder: 0,
    });
    const hidden = await taxonomy.adminLabelCreate(asAdmin(), {
      categoryId: null,
      name: '内部',
      style: 'text',
      isVisible: false,
      isEnabled: true,
      sortOrder: 1,
    });

    const product = await makeProduct(asAdmin(), { labelIds: [shown.id, hidden.id] });
    const [card] = await service.productCardsFor(harness.ctx, [Number(product.id)]);
    expect(card!.labels.map((l) => l.name)).toEqual(['热卖']);
  });

  it('gives 商品保障 its own permission atoms rather than the 商品参数 group', () => {
    const atoms: string[] = Object.values(catalogPermissions);
    expect(atoms).toContain('catalog:protection:read');
    expect(atoms).toContain('catalog:protection:write');
  });
});

// ---------------------------------------------------------------------------
// the export
// ---------------------------------------------------------------------------

describe('成本价', () => {
  const readOnly = (): Ctx =>
    harness.as({
      kind: 'admin',
      id: adminId,
      permissions: [catalogPermissions['product:read']],
      isSuper: false,
    });
  const costed = () =>
    makeProduct(asAdmin(), {
      skus: [
        {
          specValues: {},
          price: '99.00',
          cost: '22.00',
          stock: 1,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
      ],
    });

  it('is not shown to a role that may only look at products', async () => {
    const product = await costed();

    const list = await service.adminProductList(readOnly(), {
      tab: 'all',
      page: 1,
      pageSize: 20,
    } as never);
    expect(list.items[0]!.cost).toBeNull();
    const detail = await service.adminProductDetail(readOnly(), { id: product.id });
    expect(detail.cost).toBeNull();
    expect(detail.skus.map((sku) => sku.cost)).toEqual([null]);
  });

  it('is shown to whoever edits the product, since they set it', async () => {
    const product = await costed();
    const editor = harness.as({
      kind: 'admin',
      id: adminId,
      permissions: [catalogPermissions['product:read'], catalogPermissions['product:write']],
      isSuper: false,
    });

    const detail = await service.adminProductDetail(editor, { id: product.id });
    expect(detail.cost).toBe('22.00');
    expect(detail.skus.map((sku) => sku.cost)).toEqual(['22.00']);
  });
});

describe('export', () => {
  it('emits one row per SKU and reports truncation honestly', async () => {
    await makeProduct(asAdmin(), {
      specMode: true,
      specs: [{ name: '尺码', values: [{ value: 'M' }, { value: 'L' }] }],
      skus: [
        {
          specValues: { 尺码: 'M' },
          price: '99.00',
          stock: 1,
          isDefault: true,
          isVisible: true,
          sortOrder: 0,
        },
        {
          specValues: { 尺码: 'L' },
          price: '99.00',
          stock: 1,
          isDefault: false,
          isVisible: true,
          sortOrder: 1,
        },
      ],
    });
    await makeProduct(asAdmin());

    const all = await service.adminProductExport(asAdmin(), { tab: 'all', limit: 2000 });
    expect(all.rows).toHaveLength(3);
    expect(all.truncated).toBe(false);
    expect(all.filename).toBe('商品-2026-06-01.csv');

    const clipped = await service.adminProductExport(asAdmin(), { tab: 'all', limit: 1 });
    expect(clipped.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// error registry
// ---------------------------------------------------------------------------

describe('errors', () => {
  it('every catalog code the services throw is registered', () => {
    for (const code of [
      'CATALOG_CATEGORY_NOT_FOUND',
      'CATALOG_CATEGORY_TOO_DEEP',
      'CATALOG_CATEGORY_CYCLE',
      'CATALOG_CATEGORY_IN_USE',
      'CATALOG_PRODUCT_NOT_FOUND',
      'CATALOG_PRODUCT_SPU_TAKEN',
      'CATALOG_PRODUCT_NOT_ON_SALE',
      'CATALOG_PRODUCT_IN_USE',
      'CATALOG_PRODUCT_NOT_DELETED',
      'CATALOG_SKU_NOT_FOUND',
      'CATALOG_PURCHASE_LIMIT_REACHED',
      'CATALOG_MIN_PURCHASE_NOT_MET',
      'CATALOG_NOT_A_CARD_PRODUCT',
      'CATALOG_LABEL_NOT_FOUND',
      'CATALOG_LABEL_CATEGORY_NOT_FOUND',
      'CATALOG_PARAM_TEMPLATE_NOT_FOUND',
      'CATALOG_PROTECTION_NOT_FOUND',
      'CATALOG_NAME_TAKEN',
      'CATALOG_REVIEW_NOT_FOUND',
      'CATALOG_REVIEW_ALREADY_WRITTEN',
      'CATALOG_REVIEW_NOT_ALLOWED',
      'CATALOG_REVIEW_ALREADY_REPLIED',
    ]) {
      expect(new DomainError(code).unregistered, code).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 批量收藏
// ---------------------------------------------------------------------------

describe('批量收藏', () => {
  it('favourites every sellable id in one transaction and reports the state of each', async () => {
    const first = await makeProduct(asAdmin());
    const second = await makeProduct(asAdmin());
    const ctx = asUser(await makeUser(harness));

    const result = await storefront.favoriteAddBatch(ctx, {
      productIds: [first.id, second.id],
    });

    expect(result.added).toBe(2);
    expect(result.items).toEqual([
      { productId: first.id, favorited: true },
      { productId: second.id, favorited: true },
    ]);
    expect((await storefront.favoriteList(ctx, { page: 1, pageSize: 20 })).total).toBe(2);
  });

  it('is idempotent: a replay writes nothing and still answers true', async () => {
    const product = await makeProduct(asAdmin());
    const ctx = asUser(await makeUser(harness));

    await storefront.favoriteAddBatch(ctx, { productIds: [product.id] });
    const replay = await storefront.favoriteAddBatch(ctx, { productIds: [product.id] });

    expect(replay).toEqual({ added: 0, items: [{ productId: product.id, favorited: true }] });
    expect((await storefront.favoriteList(ctx, { page: 1, pageSize: 20 })).total).toBe(1);
  });

  it('reports an off-shelf id rather than failing the other ids with it', async () => {
    const live = await makeProduct(asAdmin());
    const dead = await makeProduct(asAdmin(), { status: 'off_shelf' });
    const ctx = asUser(await makeUser(harness));

    const result = await storefront.favoriteAddBatch(ctx, { productIds: [live.id, dead.id] });

    expect(result.added).toBe(1);
    expect(result.items).toEqual([
      { productId: live.id, favorited: true },
      { productId: dead.id, favorited: false },
    ]);
    // The singular route still refuses outright; the batch is the tolerant one.
    await expect(storefront.favoriteAdd(ctx, { productId: dead.id })).rejects.toMatchObject({
      code: 'CATALOG_PRODUCT_NOT_FOUND',
    });
  });

  it('counts rows, not requests, when the same id appears twice', async () => {
    const product = await makeProduct(asAdmin());
    const ctx = asUser(await makeUser(harness));

    const result = await storefront.favoriteAddBatch(ctx, {
      productIds: [product.id, product.id],
    });

    expect(result.added).toBe(1);
    expect(result.items).toEqual([
      { productId: product.id, favorited: true },
      { productId: product.id, favorited: true },
    ]);
  });
});
