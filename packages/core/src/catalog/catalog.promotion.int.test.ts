import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { presaleActivities } from '@shop/db/schema/presale';
import { groupbuyActivities } from '@shop/db/schema/groupbuy';
import { productPromotions } from '@shop/db/schema/catalog-promotion';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import { presaleActivityForm } from '@shop/contracts/presale/schemas';
import { groupbuyActivityForm } from '@shop/contracts/groupbuy/schemas';
import { checkoutPreviewBody, checkoutCreateBody } from '@shop/contracts/order/schemas';
import type { AdminProductDetail, AdminProductForm } from '@shop/contracts/catalog/schemas';
import type { ProductPromotionInput } from '@shop/contracts/catalog/promotion';
import { catalogStockPort } from './catalog.stock';
import * as service from './catalog.service';
import * as storefront from './catalog.storefront.service';
import * as presale from '../presale';
import * as groupbuy from '../groupbuy';
import * as order from '../order';
import * as cart from '../cart';
import { makeProduct, makeUser, productForm, userActor } from './catalog.fixtures.repo';
import { assertProductPromotionPurchase } from './catalog.promotion';

let harness: TestCtx;
const NOW = '2026-06-01T00:00:00.000Z';
const END = '2099-12-31T15:59:59.000Z';
beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);
afterAll(async () => {
  await harness?.close();
});
beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  presale.registerPresaleDomain();
  groupbuy.registerGroupbuyDomain();
});
function input(mode: 'presale' | 'groupbuy', version = 0): ProductPromotionInput {
  return {
    mode,
    expectedVersion: version,
    settings: {
      endAt: END,
      shipAfterDays: 10,
      seatsRequired: 2,
      skus: [{ specValues: {}, price: '49.00' }],
    },
  };
}
function edit(product: AdminProductDetail, promotion?: ProductPromotionInput): AdminProductForm {
  return productForm({
    name: product.name,
    kind: product.kind,
    categoryIds: product.categoryIds,
    skus: product.skus.map((sku) => ({
      specValues: sku.specValues,
      price: sku.price,
      stock: sku.stock,
      expectedStock: sku.stock,
      isVisible: sku.isVisible,
      isDefault: sku.isDefault,
      sortOrder: sku.sortOrder,
    })),
    ...(promotion ? { promotion } : {}),
  });
}

describe('PROMO-001 — one current promotion per product', () => {
  it('creates the product and its activity together, with current SKU ids and decimal prices', async () => {
    const product = await makeProduct(harness.ctx, { promotion: input('presale') });
    expect(product.promotion).toMatchObject({ mode: 'presale', conflict: false });
    const activity = await presale.adminActivityDetail(harness.ctx, {
      id: product.promotion!.activityId!,
    });
    expect(activity).toMatchObject({
      productId: product.id,
      price: '49.00',
      shipAfterDays: 10,
      stock: 10,
    });
    expect(activity.skus[0]?.skuId).toBe(product.skus[0]?.id);
    const page = await storefront.productDetail(harness.ctx, { id: product.id });
    expect(page.promotion).toMatchObject({ kind: 'presale', price: '49.00', canBuy: true });
  });

  it('switches mode by ending the old campaign and keeps history', async () => {
    const first = await makeProduct(harness.ctx, { promotion: input('presale') });
    const second = await service.adminProductUpdate(
      harness.ctx,
      { id: first.id },
      edit(first, input('groupbuy', first.promotion!.version)),
    );
    expect(second.promotion?.mode).toBe('groupbuy');
    expect(
      (await presale.adminActivityDetail(harness.ctx, { id: first.promotion!.activityId! })).status,
    ).toBe('ended');
    await service.adminProductUpdate(
      harness.ctx,
      { id: first.id },
      edit(second, { mode: 'normal', expectedVersion: second.promotion!.version }),
    );
    expect(
      (await groupbuy.adminActivityDetail(harness.ctx, { id: second.promotion!.activityId! }))
        .status,
    ).toBe('ended');
    expect((await storefront.productDetail(harness.ctx, { id: first.id })).promotion).toBeNull();
  });

  it('rejects a conflicting legacy activity write', async () => {
    const product = await makeProduct(harness.ctx, { promotion: input('presale') });
    await expect(
      groupbuy.adminActivityCreate(
        harness.ctx,
        groupbuyActivityForm.parse({
          productId: product.id,
          title: '新拼单',
          price: '45.00',
          stock: 10,
          seatsRequired: 2,
          groupTtlSeconds: 86400,
          startAt: NOW,
          endAt: END,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_PROMOTION_CONFLICT' });
  });

  it('serializes two legacy creates across promotion kinds', async () => {
    const product = await makeProduct(harness.ctx);
    const other = forkTestCtx(harness);
    const report = await runConcurrently(2, async (index) =>
      index === 0
        ? presale.adminActivityCreate(
            harness.ctx,
            presaleActivityForm.parse({
              productId: product.id,
              title: '预售',
              price: '49.00',
              stock: 10,
              startAt: NOW,
              endAt: END,
            }),
          )
        : groupbuy.adminActivityCreate(
            other,
            groupbuyActivityForm.parse({
              productId: product.id,
              title: '拼单',
              price: '45.00',
              stock: 10,
              startAt: NOW,
              endAt: END,
              seatsRequired: 2,
              groupTtlSeconds: 86400,
            }),
          ),
    );
    expect(report.winners).toBe(1);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]).toMatchObject({ code: 'CATALOG_PROMOTION_CONFLICT' });
  });

  it('requires an explicit choice for legacy conflicts and ends the unselected campaigns', async () => {
    const product = await makeProduct(harness.ctx, { promotion: input('presale') });
    const [legacy] = await harness.ctx.db
      .insert(groupbuyActivities)
      .values({
        productId: Number(product.id),
        title: '旧拼单',
        price: '40.00',
        stock: 10,
        seatsRequired: 2,
        groupTtlSeconds: 86400,
        startAt: new Date(NOW),
        endAt: new Date(END),
        status: 'active',
      })
      .returning();
    const state = await service.adminProductDetail(harness.ctx, { id: product.id });
    expect(state.promotion?.conflict).toBe(true);
    await expect(
      assertProductPromotionPurchase(harness.ctx, harness.ctx.db, [Number(product.id)], 'normal'),
    ).rejects.toMatchObject({ code: 'CATALOG_PROMOTION_CONFLICT' });
    const chosen = state.promotion!.candidates.find((item) => item.kind === 'presale')!;
    const saved = await service.adminProductUpdate(
      harness.ctx,
      { id: product.id },
      edit(state, {
        mode: 'presale',
        expectedVersion: state.promotion!.version,
        activityId: chosen.activityId,
        settings: chosen.settings!,
      }),
    );
    expect(saved.promotion?.conflict).toBe(false);
    expect(
      (await groupbuy.adminActivityDetail(harness.ctx, { id: String(legacy!.id) })).status,
    ).toBe('ended');
  });
});

describe('PROMO-002 — atomic product edits and stale-editor protection', () => {
  it('rolls back product changes when campaign validation fails', async () => {
    const product = await makeProduct(harness.ctx);
    const promotion = input('groupbuy');
    promotion.settings!.startAt = '2100-01-01T00:00:00.000Z';
    await expect(
      service.adminProductUpdate(
        harness.ctx,
        { id: product.id },
        { ...edit(product, promotion), name: '不能保存的名称' },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_PROMOTION_INVALID' });
    expect((await service.adminProductDetail(harness.ctx, { id: product.id })).name).toBe(
      product.name,
    );
    expect(await harness.ctx.db.select().from(productPromotions)).toHaveLength(0);
  });

  it('lets only one concurrent editor change the mode', async () => {
    const product = await makeProduct(harness.ctx);
    const other = forkTestCtx(harness);
    const report = await runConcurrently(2, (index) =>
      service.adminProductUpdate(
        index === 0 ? harness.ctx : other,
        { id: product.id },
        edit(product, input(index === 0 ? 'presale' : 'groupbuy')),
      ),
    );
    expect(report.winners).toBe(1);
    expect(report.rejected[0]).toMatchObject({ code: 'CATALOG_PROMOTION_CHANGED' });
  });

  it('preserves activity configuration when a product-only editor saves', async () => {
    const product = await makeProduct(harness.ctx, { promotion: input('presale') });
    const ctx = harness.as({
      kind: 'admin',
      id: null,
      isSuper: false,
      permissions: ['catalog:product:write'],
    });
    const saved = await service.adminProductUpdate(
      ctx,
      { id: product.id },
      { ...edit(product), name: '更新商品名称' },
    );
    expect(saved.promotion?.activityId).toBe(product.promotion?.activityId);
    expect(saved.promotion?.candidates[0]?.settings).toBeUndefined();
    await expect(
      service.adminProductUpdate(
        ctx,
        { id: product.id },
        edit(saved, { mode: 'normal', expectedVersion: saved.promotion!.version }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('PROMO-003 — presale checkout cannot be bypassed', () => {
  it('refuses normal preview, normal creation and adding to the cart', async () => {
    const product = await makeProduct(harness.ctx, { promotion: input('presale') });
    const ctx = harness.as(userActor(await makeUser(harness)));
    const body = {
      source: 'buy-now',
      kind: 'normal',
      item: { skuId: product.skus[0]!.id, quantity: 1 },
    };
    await expect(order.preview(ctx, checkoutPreviewBody.parse(body))).rejects.toMatchObject({
      code: 'CATALOG_PRESALE_REQUIRED',
    });
    await expect(
      order.create(
        ctx,
        checkoutCreateBody.parse({ ...body, idempotencyKey: 'presale-normal-bypass' }),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_PRESALE_REQUIRED' });
    await expect(
      cart.addItem(ctx, { skuId: product.skus[0]!.id, quantity: 1 }),
    ).rejects.toMatchObject({ code: 'CATALOG_PRESALE_REQUIRED' });
  });

  it('returns to ordinary buying on expiry and creates a new campaign when reenabled', async () => {
    const product = await makeProduct(harness.ctx, { promotion: input('presale') });
    harness.clock.set('2100-01-01T00:00:00.000Z');
    expect((await storefront.productDetail(harness.ctx, { id: product.id })).promotion).toBeNull();
    await expect(
      assertProductPromotionPurchase(harness.ctx, harness.ctx.db, [Number(product.id)], 'normal'),
    ).resolves.toBeUndefined();
    const current = await service.adminProductDetail(harness.ctx, { id: product.id });
    const promotion = input('presale', current.promotion!.version);
    promotion.activityId = current.promotion!.activityId!;
    promotion.settings!.endAt = '2101-01-01T00:00:00.000Z';
    const saved = await service.adminProductUpdate(
      harness.ctx,
      { id: product.id },
      edit(current, promotion),
    );
    expect(saved.promotion?.activityId).not.toBe(product.promotion?.activityId);
    const [old] = await harness.ctx.db
      .select()
      .from(presaleActivities)
      .where(eq(presaleActivities.id, Number(product.promotion!.activityId)));
    expect(old?.status).toBe('ended');
  });
});

describe('promotion compatibility and lifecycle', () => {
  it('blocks checkout from a cart filled before presale was enabled', async () => {
    const product = await makeProduct(harness.ctx);
    const ctx = harness.as(userActor(await makeUser(harness)));
    const added = await cart.addItem(ctx, { skuId: product.skus[0]!.id, quantity: 1 });
    await service.adminProductUpdate(
      harness.ctx,
      { id: product.id },
      edit(product, input('presale')),
    );
    await expect(
      order.preview(
        ctx,
        checkoutPreviewBody.parse({
          source: 'cart',
          kind: 'normal',
          cartItemIds: [added.item!.id],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_PRESALE_REQUIRED' });
  });

  it('refuses legacy writes without product-write permission', async () => {
    const product = await makeProduct(harness.ctx);
    const ctx = harness.as({
      kind: 'admin',
      id: null,
      isSuper: false,
      permissions: ['presale:activity:write'],
    });
    await expect(
      presale.adminActivityCreate(
        ctx,
        presaleActivityForm.parse({
          productId: product.id,
          title: '权限测试',
          price: '49.00',
          stock: 10,
          startAt: NOW,
          endAt: END,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('invalidates an editor revision when the legacy API ends its campaign', async () => {
    const product = await makeProduct(harness.ctx, { promotion: input('presale') });
    const activity = await presale.adminActivityDetail(harness.ctx, {
      id: product.promotion!.activityId!,
    });
    await presale.adminActivityUpdate(
      harness.ctx,
      { id: activity.id },
      presaleActivityForm.parse({
        productId: product.id,
        title: activity.title,
        price: activity.price,
        stock: activity.stock,
        startAt: activity.startAt,
        endAt: activity.endAt,
        status: 'ended',
        shipAfterDays: 10,
      }),
    );
    await expect(
      service.adminProductUpdate(
        harness.ctx,
        { id: product.id },
        edit(product, input('presale', product.promotion!.version)),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_PROMOTION_CHANGED' });
  });

  it('backfills only unambiguous legacy campaigns in migration 0027', async () => {
    const unique = await makeProduct(harness.ctx, { promotion: input('presale') });
    const conflict = await makeProduct(harness.ctx, { promotion: input('presale') });
    await harness.ctx.db.insert(groupbuyActivities).values({
      productId: Number(conflict.id),
      title: '冲突旧活动',
      price: '40.00',
      stock: 10,
      seatsRequired: 2,
      groupTtlSeconds: 86400,
      startAt: new Date(NOW),
      endAt: new Date(END),
      status: 'active',
    });
    await harness.ctx.db.delete(productPromotions);
    const migration = await readFile(
      new URL('../../../db/migrations/0027_product_promotions.sql', import.meta.url),
      'utf8',
    );
    await harness.ctx.db.execute(
      sql.raw(migration.slice(migration.indexOf('WITH candidates AS ('))),
    );
    const links = await harness.ctx.db.select().from(productPromotions);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      productId: Number(unique.id),
      presaleActivityId: Number(unique.promotion!.activityId),
      groupbuyActivityId: null,
    });
    expect(
      (await service.adminProductDetail(harness.ctx, { id: conflict.id })).promotion?.conflict,
    ).toBe(true);
  });
});

describe('inventory serialization with product edits', () => {
  it('reserves and restores stock while editors save without deadlock or stale counter writes', async () => {
    const product = await makeProduct(harness.ctx, { promotion: input('presale') });
    const other = forkTestCtx(harness);
    const lines = [{ skuId: Number(product.skus[0]!.id), quantity: 1 }];
    const report = await runConcurrently(8, async (index) => {
      if (index % 2 === 0)
        return service.adminProductUpdate(harness.ctx, { id: product.id }, edit(product));
      return other.withTx((tx) => catalogStockPort.reserve(tx, 10000 + index, lines));
    });
    expect(report.rejected).toEqual([]);
    const reserved = await service.adminProductDetail(harness.ctx, { id: product.id });
    expect(reserved.skus[0]?.stock).toBe(6);
    for (const index of [1, 3, 5, 7]) {
      await other.withTx((tx) => catalogStockPort.release(tx, 10000 + index, lines));
    }
    const restored = await service.adminProductDetail(harness.ctx, { id: product.id });
    expect(restored.skus[0]?.stock).toBe(10);
    expect(restored.sales).toBe(0);
  });
});

it('shows the minimum enabled SKU price for a legacy activity whose fallback price differs', async () => {
  const product = await makeProduct(harness.ctx);
  await presale.adminActivityCreate(
    harness.ctx,
    presaleActivityForm.parse({
      productId: product.id,
      title: '旧预售价格',
      status: 'active',
      price: '99.00',
      stock: 10,
      startAt: NOW,
      endAt: END,
      shipAfterDays: 7,
      skus: [{ skuId: product.skus[0]!.id, price: '49.00', stock: 10 }],
    }),
  );
  expect((await storefront.productDetail(harness.ctx, { id: product.id })).promotion?.price).toBe(
    '49.00',
  );
});

it('reprices an order after an editor changes a SKU before the product lock is acquired', async () => {
  const product = await makeProduct(harness.ctx, { kind: 'virtual_manual' });
  const buyer = harness.as(userActor(await makeUser(harness)));
  const editor = forkTestCtx(harness);
  const actual = order.resolveCatalogPort();
  order.registerCatalogPort({
    ...actual,
    async assertPurchase(ctx, db, ids, kind) {
      const body = edit(product);
      body.skus[0]!.price = '109.00';
      await service.adminProductUpdate(editor, { id: product.id }, body);
      await actual.assertPurchase?.(ctx, db, ids, kind);
    },
  });
  try {
    await expect(
      order.create(
        buyer,
        checkoutCreateBody.parse({
          source: 'buy-now',
          kind: 'normal',
          item: { skuId: product.skus[0]!.id, quantity: 1 },
          expectedPayableAmount: '99.00',
          idempotencyKey: 'fresh-price-after-product-lock',
        }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_PRICE_CHANGED' });
  } finally {
    order.registerCatalogPort(actual);
  }
  expect((await service.adminProductDetail(harness.ctx, { id: product.id })).price).toBe('109.00');
});
