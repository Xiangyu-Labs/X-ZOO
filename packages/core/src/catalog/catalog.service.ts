import type { PageQuery } from '@shop/contracts/conventions';
import type {
  AdminProductDetail,
  AdminProductForm,
  AdminProductListItem,
  AdminProductListQuery,
  AdminProductTab,
  ProductCard,
  ProductCardLabel,
  ProductCustomFormField,
  ProductCategory,
  ProductCategoryForm,
  ProductCategoryListQuery,
  ProductCategoryNode,
  ProductExportResult,
  ProductSku,
  ProductSpec,
  ProductVirtualCard,
  StockWarningItem,
  VirtualCardImportBody,
} from '@shop/contracts/catalog/schemas';
import type { DbOrTx, Tx } from '@shop/db';
import { randomBytes } from 'node:crypto';

import { hasPermission } from '../auth/rbac';
import { DomainError } from '../kernel/errors';
import { shopDay } from '../kernel/shop-time';
import { sanitizeHtml } from '../kernel/sanitize-html';
import { requireAdminId, type Ctx } from '../kernel/context';
import { catalogConfig } from './catalog.config';
import { catalogPermissions } from './permissions';
import * as repo from './catalog.repo';
import {
  MAX_CATEGORY_DEPTH,
  canAddToCart,
  childPath,
  comboKey,
  levelOfPath,
  salesDisplay,
  skuCodeFrom,
  skuMatrix,
  specTextOf,
  wouldCycle,
} from './catalog.rules';
import { getOrderFacts } from '../order/ports';

/**
 * Catalog services: categories, products, the spec matrix, stock warnings, the
 * export and the virtual-card pool.
 *
 * Shape, copied from the golden slice:
 *  - the service decides, the repo states. Every `if` about an affected row
 *    count is here; every SQL statement is in `catalog.repo.ts`.
 *  - a state change is wrapped in exactly one `ctx.withTx`, at the top.
 *  - the row → DTO mappings live at the bottom and are exported, because the
 *    taxonomy, review and storefront services render the same shapes.
 */

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

export function pageBounds(query: PageQuery): { offset: number; limit: number } {
  return { offset: (query.page - 1) * query.pageSize, limit: query.pageSize };
}

export function asArray<T extends string>(value: T | readonly T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? [...value] : [value as T];
}

/** Optional string fields arrive as `undefined` from the form and must be stored as `null`. */
export function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

/**
 * `X-Client-Platform` (`wechat-oa`) to the database enum (`wechat_oa`).
 *
 * The wire spelling is kebab-case because every other contract enum is; the
 * column is snake_case because every other pgEnum is. One function rather than
 * a third spelling somewhere in the middle.
 */
export function platformOf(ctx: Ctx): 'h5' | 'wechat_oa' | 'wechat_mini' | null {
  if (ctx.platform === null) return null;
  return ctx.platform === 'wechat-oa'
    ? 'wechat_oa'
    : ctx.platform === 'wechat-mini'
      ? 'wechat_mini'
      : 'h5';
}

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

export async function adminCategoryList(
  ctx: Ctx,
  query: ProductCategoryListQuery,
): Promise<{ items: ProductCategory[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listCategories(ctx.db, {
    keyword: query.keyword,
    parentId: query.parentId === undefined ? undefined : Number(query.parentId),
    isVisible: query.isVisible,
    level: query.level,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  const counts = await repo.categoryProductCounts(
    ctx.db,
    rows.map((r) => r.id),
  );
  return {
    items: rows.map((row) => toCategory(row, counts.get(row.id) ?? 0)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * The whole tree, built in memory from one query.
 *
 * Three levels and no deeper, so no recursion: a node's children are looked up
 * by `parentId` twice. A category whose parent is missing (hidden and filtered
 * out, or deleted) is dropped rather than promoted to a root — promoting it
 * would silently move a subcategory to the top of the storefront menu.
 */
export async function adminCategoryTree(
  ctx: Ctx,
  query: { visibleOnly: boolean },
): Promise<{ items: ProductCategoryNode[] }> {
  const rows = await repo.listAllCategories(ctx.db, { visibleOnly: query.visibleOnly });
  const counts = await repo.categoryProductCounts(
    ctx.db,
    rows.map((r) => r.id),
  );
  return { items: buildCategoryTree(rows, counts) };
}

export async function adminCategoryDetail(
  ctx: Ctx,
  input: { id: string },
): Promise<ProductCategory> {
  const row = await repo.findCategory(ctx.db, Number(input.id));
  if (!row) throw new DomainError('CATALOG_CATEGORY_NOT_FOUND');
  return toCategory(row, await repo.countCategoryProducts(ctx.db, row.id));
}

export async function adminCategoryCreate(
  ctx: Ctx,
  body: ProductCategoryForm,
): Promise<ProductCategory> {
  return ctx.withTx(async (tx) => {
    const now = ctx.clock.now();
    const parent = await loadParent(tx, body.parentId);
    const path = childPath(parent);
    const level = levelOfPath(path);
    if (level >= MAX_CATEGORY_DEPTH) throw new DomainError('CATALOG_CATEGORY_TOO_DEEP');

    const row = await repo.insertCategory(tx, {
      parentId: parent?.id ?? null,
      name: body.name,
      path,
      level,
      iconUrl: orNull(body.iconUrl),
      bannerUrl: orNull(body.bannerUrl),
      sortOrder: body.sortOrder,
      isVisible: body.isVisible,
      createdAt: now,
      updatedAt: now,
    });
    return toCategory(row, 0);
  });
}

/**
 * Edit, including a move to a different parent.
 *
 * A move rewrites the materialised path of the whole subtree in one statement
 * (`repo.moveSubtree`) rather than walking it, and refuses two things first:
 * making a category a descendant of itself, and pushing any descendant past the
 * third level. Without the second check an operator could drag a branch under a
 * leaf and the admin tree would simply stop rendering the part that fell off
 * the end.
 */
export async function adminCategoryUpdate(
  ctx: Ctx,
  input: { id: string },
  body: ProductCategoryForm,
): Promise<ProductCategory> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const now = ctx.clock.now();
    const row = await repo.findCategory(tx, id);
    if (!row) throw new DomainError('CATALOG_CATEGORY_NOT_FOUND');

    const parent = await loadParent(tx, body.parentId);
    if (wouldCycle({ categoryId: id, categoryPath: row.path, newParent: parent })) {
      throw new DomainError('CATALOG_CATEGORY_CYCLE');
    }

    const oldPrefix = `${row.path}${row.id}/`;
    const newPath = childPath(parent);
    const newLevel = levelOfPath(newPath);
    const newPrefix = `${newPath}${row.id}/`;
    const levelDelta = newLevel - row.level;

    if (levelDelta !== 0 || newPath !== row.path) {
      const deepest = await deepestDescendantLevel(tx, oldPrefix, row.level);
      if (deepest + levelDelta >= MAX_CATEGORY_DEPTH) {
        throw new DomainError('CATALOG_CATEGORY_TOO_DEEP');
      }
      await repo.moveSubtree(tx, { oldPrefix, newPrefix, levelDelta, now });
    }

    const { won } = await repo.updateCategory(tx, id, {
      parentId: parent?.id ?? null,
      name: body.name,
      path: newPath,
      level: newLevel,
      iconUrl: orNull(body.iconUrl),
      bannerUrl: orNull(body.bannerUrl),
      sortOrder: body.sortOrder,
      isVisible: body.isVisible,
      updatedAt: now,
    });
    if (!won) throw new DomainError('CATALOG_CATEGORY_NOT_FOUND');

    const updated = await repo.findCategory(tx, id);
    if (!updated) throw new DomainError('CATALOG_CATEGORY_NOT_FOUND');
    return toCategory(updated, await repo.countCategoryProducts(tx, id));
  });
}

/**
 * The list's 显示 switch.
 *
 * Guarded on the value it moves *from*, so two operators toggling at once do
 * not both report success — the loser is told the row moved and refetches.
 * Hiding a parent hides its subtree, because the storefront tree drops a node
 * whose parent is not visible.
 */
export async function adminCategorySetVisibility(
  ctx: Ctx,
  input: { id: string },
  body: { isVisible: boolean },
): Promise<ProductCategory> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const row = await repo.findCategory(tx, id);
    if (!row) throw new DomainError('CATALOG_CATEGORY_NOT_FOUND');
    if (row.isVisible !== body.isVisible) {
      const { won } = await repo.setCategoryVisibility(tx, {
        id,
        from: row.isVisible,
        to: body.isVisible,
        now: ctx.clock.now(),
      });
      if (!won) throw new DomainError('CATALOG_CATEGORY_NOT_FOUND');
    }
    const updated = await repo.findCategory(tx, id);
    if (!updated) throw new DomainError('CATALOG_CATEGORY_NOT_FOUND');
    return toCategory(updated, await repo.countCategoryProducts(tx, id));
  });
}

/**
 * Delete, refused while anything still points at the category.
 *
 * Both guards are inside the transaction: a product being filed under this
 * category concurrently would have to wait for this commit and then see the
 * soft-delete, and a child inserted concurrently is caught by the same read.
 */
export async function adminCategoryDelete(ctx: Ctx, input: { id: string }): Promise<void> {
  const id = Number(input.id);
  await ctx.withTx(async (tx) => {
    const row = await repo.findCategory(tx, id);
    if (!row) throw new DomainError('CATALOG_CATEGORY_NOT_FOUND');

    if ((await repo.countLiveChildren(tx, id)) > 0) {
      throw new DomainError('CATALOG_CATEGORY_IN_USE', { details: { reason: 'children' } });
    }
    if ((await repo.countCategoryProducts(tx, id)) > 0) {
      throw new DomainError('CATALOG_CATEGORY_IN_USE', { details: { reason: 'products' } });
    }

    const { won } = await repo.softDeleteCategory(tx, { id, now: ctx.clock.now() });
    if (!won) throw new DomainError('CATALOG_CATEGORY_NOT_FOUND');
  });
}

async function loadParent(
  tx: Tx,
  parentId: string | null,
): Promise<{ id: number; path: string; level: number } | null> {
  if (parentId === null) return null;
  const parent = await repo.findCategory(tx, Number(parentId));
  if (!parent) throw new DomainError('CATALOG_CATEGORY_NOT_FOUND');
  return { id: parent.id, path: parent.path, level: parent.level };
}

/** Deepest level under `prefix`, so a move can be refused before it happens. */
async function deepestDescendantLevel(tx: Tx, prefix: string, fallback: number): Promise<number> {
  const rows = await repo.listAllCategories(tx, { visibleOnly: false });
  let deepest = fallback;
  for (const row of rows) {
    if (row.path.startsWith(prefix) && row.level > deepest) deepest = row.level;
  }
  return deepest;
}

// ---------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------

export async function adminProductList(
  ctx: Ctx,
  query: AdminProductListQuery,
): Promise<{ items: AdminProductListItem[]; total: number; page: number; pageSize: number }> {
  const config = await ctx.config.get(catalogConfig);
  const { rows, total } = await repo.listProducts(ctx.db, {
    tab: query.tab,
    keyword: query.keyword,
    categoryId: query.categoryId === undefined ? undefined : Number(query.categoryId),
    labelId: query.labelId === undefined ? undefined : Number(query.labelId),
    ids: query.ids?.map(Number),
    kind: query.kind,
    priceFrom: query.priceFrom,
    priceTo: query.priceTo,
    stockThreshold: config.stockWarningThreshold,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });

  const items = await decorateProducts(ctx.db, rows, seesCost(ctx));
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function adminProductDetail(
  ctx: Ctx,
  input: { id: string },
): Promise<AdminProductDetail> {
  const id = Number(input.id);
  // Deleted products are readable so the recycle bin can show what it is about
  // to restore.
  const row = await repo.findProduct(ctx.db, id, { includeDeleted: true });
  if (!row) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');
  return buildProductDetail(ctx, row);
}

export async function adminProductCreate(
  ctx: Ctx,
  body: AdminProductForm,
): Promise<AdminProductDetail> {
  return ctx.withTx(async (tx) => {
    await assertLinksExist(tx, body);
    if (body.spu) {
      const taken = await repo.spuTakenBy(tx, { spu: body.spu });
      if (taken !== null) throw new DomainError('CATALOG_PRODUCT_SPU_TAKEN');
    }

    const now = ctx.clock.now();
    const row = await repo.insertProduct(tx, {
      ...productValues(body),
      createdAt: now,
      updatedAt: now,
    });
    await writeProductChildren(tx, row.id, body, now);
    await repo.rollupProduct(tx, row.id);

    const saved = await repo.findProduct(tx, row.id, { includeDeleted: true });
    return buildProductDetail(ctx, saved!, tx);
  });
}

/**
 * Edit.
 *
 * The SKUs are *reconciled*, never replaced: an incoming row is matched to an
 * existing SKU by its spec combination (`comboKey`), so re-pricing a variant
 * keeps its id, its stock, its sales and every cart row and order item that
 * points at it. Deleting and re-inserting the SKUs on every save would reset
 * stock to whatever the editor happened to be showing and orphan live carts.
 */
export async function adminProductUpdate(
  ctx: Ctx,
  input: { id: string },
  body: AdminProductForm,
): Promise<AdminProductDetail> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const existing = await repo.findProduct(tx, id);
    if (!existing) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');

    await assertLinksExist(tx, body);
    if (body.spu) {
      const taken = await repo.spuTakenBy(tx, { spu: body.spu, exceptProductId: id });
      if (taken !== null) throw new DomainError('CATALOG_PRODUCT_SPU_TAKEN');
    }

    const now = ctx.clock.now();
    const { won } = await repo.updateProduct(tx, id, { ...productValues(body), updatedAt: now });
    if (!won) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');

    await writeProductChildren(tx, id, body, now);
    await repo.rollupProduct(tx, id);

    const saved = await repo.findProduct(tx, id);
    return buildProductDetail(ctx, saved!, tx);
  });
}

/**
 * 上架 / 下架.
 *
 * One conditional update guarded on the status it moves from. The moment it
 * commits the product is gone from every storefront list (they all filter
 * `status = 'on_shelf'`) and unsellable (`getSkuForSale` reads through
 * `findSellableProduct`), which is the whole of "taking a product off the shelf
 * hides it and refuses the order".
 *
 * Putting a product on the shelf with no stock is allowed: a sold-out product
 * that is visible is a legitimate merchandising choice, and the stock guard
 * lives in `reserve`, not here.
 */
export async function adminProductSetStatus(
  ctx: Ctx,
  input: { id: string },
  body: { status: 'on_shelf' | 'off_shelf' },
): Promise<AdminProductDetail> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const row = await repo.findProduct(tx, id);
    if (!row) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');

    if (row.status !== body.status) {
      const { won } = await repo.setProductStatus(tx, {
        id,
        from: row.status === 'draft' ? ['draft', 'off_shelf', 'on_shelf'] : [row.status],
        to: body.status,
        now: ctx.clock.now(),
      });
      if (!won) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');
    }

    const saved = await repo.findProduct(tx, id);
    return buildProductDetail(ctx, saved!, tx);
  });
}

/**
 * Into the recycle bin.
 *
 * Refused while an unfinished order still references the product, because the
 * order detail page renders the product name from the live row when the
 * snapshot is missing a field. The check goes through `OrderFactsPort`, not
 * through the order tables.
 */
export async function adminProductDelete(ctx: Ctx, input: { id: string }): Promise<void> {
  const id = Number(input.id);
  await ctx.withTx(async (tx) => {
    const row = await repo.findProduct(tx, id);
    if (!row) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');

    if (await getOrderFacts().hasOpenOrders(tx, id)) {
      throw new DomainError('CATALOG_PRODUCT_IN_USE');
    }

    const { won } = await repo.softDeleteProduct(tx, { id, now: ctx.clock.now() });
    if (!won) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');
  });
}

/** Out of the recycle bin, always as `off_shelf`. */
export async function adminProductRestore(
  ctx: Ctx,
  input: { id: string },
): Promise<AdminProductDetail> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const { won } = await repo.restoreProduct(tx, { id, now: ctx.clock.now() });
    if (!won) {
      const exists = await repo.findProduct(tx, id, { includeDeleted: true });
      throw new DomainError(exists ? 'CATALOG_PRODUCT_NOT_DELETED' : 'CATALOG_PRODUCT_NOT_FOUND');
    }
    const saved = await repo.findProduct(tx, id);
    return buildProductDetail(ctx, saved!, tx);
  });
}

/**
 * The spec matrix, computed on the server.
 *
 * The editor used to build this in the browser and the server built it again
 * on save; the two disagreed about empty values, so a combination could be
 * priced in the UI and missing from the database. One function
 * (`rules.skuMatrix`), called from here and from the save path.
 */
export function adminSkuMatrix(
  _ctx: Ctx,
  body: { specs: { name: string; values: { value: string; imageUrl?: string | undefined }[] }[] },
): { rows: { specValues: Record<string, string>; specText: string }[] } {
  return { rows: skuMatrix(body.specs) };
}

export async function adminStockWarnings(
  ctx: Ctx,
  query: {
    keyword?: string | undefined;
    categoryId?: string | undefined;
    threshold?: number | undefined;
  } & PageQuery,
): Promise<{ items: StockWarningItem[]; total: number; page: number; pageSize: number }> {
  const config = await ctx.config.get(catalogConfig);
  const threshold = query.threshold ?? config.stockWarningThreshold;
  const { rows, total } = await repo.listStockWarnings(ctx.db, {
    threshold,
    keyword: query.keyword,
    categoryId: query.categoryId === undefined ? undefined : Number(query.categoryId),
    ...pageBounds(query),
  });
  return {
    items: rows.map(({ sku, product }) => ({
      productId: String(product.id),
      productName: product.name,
      imageUrl: product.imageUrl,
      status: product.status,
      skuId: String(sku.id),
      specText: sku.specText,
      skuCode: sku.skuCode,
      stock: sku.stock,
      threshold,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

const EXPORT_COLUMNS = [
  { key: 'id', title: '商品ID' },
  { key: 'name', title: '商品名称' },
  { key: 'spu', title: '商品编码' },
  { key: 'kind', title: '商品类型' },
  { key: 'status', title: '状态' },
  { key: 'categoryNames', title: '分类' },
  { key: 'skuCode', title: '规格编码' },
  { key: 'specText', title: '规格' },
  { key: 'price', title: '售价' },
  { key: 'cost', title: '成本价' },
  { key: 'stock', title: '库存' },
  { key: 'sales', title: '销量' },
  { key: 'barCode', title: '条码' },
] as const;

/**
 * 商品导出, one row per SKU.
 *
 * Returns data, not a file: `handle()` serialises every response as JSON and
 * validates it against the contract, and a second, unvalidated pipeline for
 * file streams would be the only place in the system where a response never
 * met its schema. The admin page turns these rows into the download. The
 * configured `exportRowLimit` is a hard ceiling — a 200 000-row export is an
 * out-of-memory incident, not a feature.
 */
export async function adminProductExport(
  ctx: Ctx,
  query: {
    tab: AdminProductTab;
    keyword?: string | undefined;
    categoryId?: string | undefined;
    kind?: string | undefined;
    limit: number;
  },
): Promise<ProductExportResult> {
  requireAdminId(ctx);
  const config = await ctx.config.get(catalogConfig);
  const limit = Math.min(query.limit, config.exportRowLimit);

  const { rows, total } = await repo.listProducts(ctx.db, {
    tab: query.tab,
    keyword: query.keyword,
    categoryId: query.categoryId === undefined ? undefined : Number(query.categoryId),
    kind: query.kind as repo.ProductKindValue | undefined,
    stockThreshold: config.stockWarningThreshold,
    offset: 0,
    limit,
  });

  const productIds = rows.map((r) => r.id);
  const [skusByProduct, categoryIds] = await Promise.all([
    repo.listSkusForProducts(ctx.db, productIds),
    repo.categoryIdsFor(ctx.db, productIds),
  ]);
  const names = await repo.categoryNames(ctx.db, [...new Set([...categoryIds.values()].flat())]);

  const out: Record<string, string>[] = [];
  for (const product of rows) {
    const categoryNames = (categoryIds.get(product.id) ?? [])
      .map((cid) => names.get(cid) ?? '')
      .filter(Boolean)
      .join(' / ');
    for (const sku of skusByProduct.get(product.id) ?? []) {
      out.push({
        id: String(product.id),
        name: product.name,
        spu: product.spu ?? '',
        kind: product.kind,
        status: product.status,
        categoryNames,
        skuCode: sku.skuCode,
        specText: sku.specText,
        price: sku.price,
        cost: sku.cost ?? '',
        stock: String(sku.stock),
        sales: String(sku.sales),
        barCode: sku.barCode ?? '',
      });
    }
  }

  // The shop's day, in Chinese, as staff file it.
  const stamp = shopDay(ctx.clock.now());
  return {
    filename: `商品-${stamp}.csv`,
    columns: EXPORT_COLUMNS.map((c) => ({ key: c.key, title: c.title })),
    rows: out,
    total,
    truncated: total > rows.length,
  };
}

// ---------------------------------------------------------------------------
// virtual cards
// ---------------------------------------------------------------------------

export async function adminVirtualCardList(
  ctx: Ctx,
  input: { id: string },
  query: { skuId?: string | undefined; state?: repo.CardStateValue | undefined } & PageQuery,
): Promise<{ items: ProductVirtualCard[]; total: number; page: number; pageSize: number }> {
  const productId = Number(input.id);
  const product = await repo.findProduct(ctx.db, productId);
  if (!product) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');

  const { rows, total } = await repo.listVirtualCards(ctx.db, {
    productId,
    skuId: query.skuId === undefined ? undefined : Number(query.skuId),
    state: query.state,
    ...pageBounds(query),
  });
  const skus = await repo.skusByIds(
    ctx.db,
    rows.map((r) => r.skuId),
  );
  return {
    items: rows.map((row) => ({
      id: String(row.id),
      skuId: String(row.skuId),
      specText: skus.get(row.skuId)?.specText ?? '',
      cardKey: row.cardKey,
      cardNo: row.cardNo,
      cardSecret: row.cardSecret,
      state: row.state,
      orderItemId: row.orderItemId === null ? null : String(row.orderItemId),
      claimedByUserId: row.claimedByUserId === null ? null : String(row.claimedByUserId),
      claimedAt: row.claimedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * Import a batch of card keys.
 *
 * The pool *is* the stock: after the insert the SKU's stock is set to the count
 * of unclaimed cards in one statement, rather than incremented by the number of
 * rows this call happened to add. Deriving it is what stops the two drifting:
 * with an increment, a failed half-import would leave the shop selling cards it
 * did not have.
 *
 * Duplicates are reported, not fatal: an operator re-uploading a spreadsheet
 * with ten new rows at the bottom should get ten cards and a list of what was
 * already there.
 */
export async function adminVirtualCardImport(
  ctx: Ctx,
  input: { id: string },
  body: VirtualCardImportBody,
): Promise<{ imported: number; skippedCardNos: string[]; stock: number }> {
  const productId = Number(input.id);
  const skuId = Number(body.skuId);

  return ctx.withTx(async (tx) => {
    const product = await repo.findProduct(tx, productId);
    if (!product) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');
    if (product.kind !== 'virtual_card') throw new DomainError('CATALOG_NOT_A_CARD_PRODUCT');

    const sku = await repo.findSku(tx, skuId);
    if (!sku || sku.productId !== productId) throw new DomainError('CATALOG_SKU_NOT_FOUND');

    const incoming = dedupeByCardNo(body.cards);
    const existing = await repo.existingCardNos(tx, {
      skuId,
      cardNos: incoming.map((c) => c.cardNo),
    });
    const fresh = incoming.filter((c) => !existing.has(c.cardNo));

    await repo.insertVirtualCards(
      tx,
      fresh.map((card) => ({
        productId,
        skuId,
        cardKey: newCardKey(),
        cardNo: card.cardNo,
        cardSecret: orNull(card.cardSecret),
        state: 'unclaimed' as const,
        createdAt: ctx.clock.now(),
        updatedAt: ctx.clock.now(),
      })),
    );

    const stock = await repo.syncCardStock(tx, skuId);
    await repo.rollupProduct(tx, productId);

    return {
      imported: fresh.length,
      skippedCardNos: [...existing].sort(),
      stock,
    };
  });
}

/** Withdraw unclaimed cards. A claimed card is never voided: somebody is holding it. */
export async function adminVirtualCardVoid(
  ctx: Ctx,
  input: { id: string },
  body: { cardIds: string[] },
): Promise<{ voided: number; stock: number }> {
  const productId = Number(input.id);
  return ctx.withTx(async (tx) => {
    const product = await repo.findProduct(tx, productId);
    if (!product) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');

    const cardIds = body.cardIds.map(Number);
    const voided = await repo.voidVirtualCards(tx, { productId, cardIds, now: ctx.clock.now() });

    const cards = await repo.listVirtualCards(tx, {
      productId,
      offset: 0,
      limit: 1,
    });
    const skuId = cards.rows[0]?.skuId;
    const stock = skuId === undefined ? 0 : await repo.syncCardStock(tx, skuId);
    await repo.rollupProduct(tx, productId);
    return { voided, stock };
  });
}

function dedupeByCardNo(
  cards: readonly { cardNo: string; cardSecret?: string | undefined }[],
): { cardNo: string; cardSecret?: string | undefined }[] {
  const seen = new Set<string>();
  return cards.filter((card) => !seen.has(card.cardNo) && seen.add(card.cardNo));
}

function newCardKey(): string {
  return skuCodeFrom(randomBytes(12)).replace(/^SKU/, 'CARD');
}

// ---------------------------------------------------------------------------
// the domain API other domains call
// ---------------------------------------------------------------------------

export interface SaleableSku {
  productId: number;
  productName: string;
  productKind: repo.ProductKindValue;
  imageUrl: string;
  skuId: number;
  skuCode: string;
  specText: string;
  specValues: Record<string, string>;
  price: string;
  originalPrice: string | null;
  stock: number;
  weight: string | null;
  volume: string | null;
  minPurchaseQuantity: number;
  purchaseLimitMode: 'none' | 'per_order' | 'lifetime';
  purchaseLimitQuantity: number | null;
  chargesFreight: boolean;
  freightMode: 'free' | 'fixed' | 'template';
  fixedFreight: string | null;
  shippingTemplateId: number | null;
}

/**
 * **The** read the cart and the order builder go through.
 *
 * It refuses anything that is not on the shelf, which is the other half of 下架
 * hiding a product everywhere: an operator taking a product down mid-checkout
 * must make the next `createOrder` fail rather than let a hidden product be
 * bought. The caller gets `CATALOG_PRODUCT_NOT_ON_SALE` and can name the line.
 *
 * It does **not** reserve anything and it does not promise the stock it
 * reports will still be there — only `StockPort.reserve`'s conditional update
 * can promise that, and it is the only thing allowed to.
 */
export async function getSkuForSale(ctx: Ctx, skuId: number): Promise<SaleableSku> {
  const sku = await repo.findSku(ctx.db, skuId);
  if (!sku || !sku.isVisible) throw new DomainError('CATALOG_SKU_NOT_FOUND');

  const product = await repo.findSellableProduct(ctx.db, sku.productId);
  if (!product) throw new DomainError('CATALOG_PRODUCT_NOT_ON_SALE');

  return {
    productId: product.id,
    productName: product.name,
    productKind: product.kind,
    imageUrl: sku.imageUrl ?? product.imageUrl,
    skuId: sku.id,
    skuCode: sku.skuCode,
    specText: sku.specText,
    specValues: sku.specValues,
    price: sku.price,
    originalPrice: sku.originalPrice,
    stock: sku.stock,
    weight: sku.weight,
    volume: sku.volume,
    minPurchaseQuantity: product.minPurchaseQuantity,
    purchaseLimitMode: product.purchaseLimitMode,
    purchaseLimitQuantity: product.purchaseLimitQuantity,
    chargesFreight: product.kind === 'physical',
    freightMode: product.freightMode,
    fixedFreight: product.fixedFreight,
    shippingTemplateId: product.shippingTemplateId,
  };
}

/**
 * 起购 / 限购, decided against what the shopper has already bought.
 *
 * `lifetime` needs the order history, which arrives through `OrderFactsPort`
 * rather than a join, so the catalog never reads an order table.
 */
export async function checkPurchaseAllowance(
  tx: Tx,
  ctx: Ctx,
  input: { userId: number; skuId: number; quantity: number },
): Promise<void> {
  const sku = await repo.findSku(tx, input.skuId);
  if (!sku) throw new DomainError('CATALOG_SKU_NOT_FOUND');
  const product = await repo.findSellableProduct(tx, sku.productId);
  if (!product) throw new DomainError('CATALOG_PRODUCT_NOT_ON_SALE');

  const alreadyBought =
    product.purchaseLimitMode === 'lifetime'
      ? await getOrderFacts().purchasedQuantity(tx, {
          userId: input.userId,
          productId: product.id,
        })
      : 0;

  const verdict = checkLimit(product, input.quantity, alreadyBought);
  if (verdict === 'below-minimum') {
    throw new DomainError('CATALOG_MIN_PURCHASE_NOT_MET', {
      details: { minQuantity: product.minPurchaseQuantity },
    });
  }
  if (verdict === 'limit-reached') {
    throw new DomainError('CATALOG_PURCHASE_LIMIT_REACHED', {
      details: { limitQuantity: product.purchaseLimitQuantity },
    });
  }
  void ctx;
}

/**
 * 加购 as a product event.
 *
 * The stats product page reports 加购件数 from `product_events`, next to views,
 * orders and payments, and this is the only writer of the `cart` kind — without
 * it the column would read zero however busy the shop was. The cart calls this
 * from inside its own transaction, beside the `cart_items` upsert, so the
 * number and the row it describes commit together or not at all.
 *
 * `(tx, ctx, input)` — the caller owns the transaction, matching
 * `checkPurchaseAllowance` and the platform's other "join the transaction you
 * are already in" primitives. The cart may not reach `catalog.repo` itself
 * (`docs/conventions.md`: a repo is private to its domain), and this is the
 * whole of the seam: no read, no verdict, one insert.
 */
export async function recordCartAdd(
  tx: Tx,
  ctx: Ctx,
  input: { productId: number; skuId: number; userId: number; quantity: number },
): Promise<void> {
  await repo.recordCartEvent(tx, {
    productId: input.productId,
    skuId: input.skuId,
    userId: input.userId,
    quantity: input.quantity,
    platform: platformOf(ctx),
  });
}

function checkLimit(
  product: repo.ProductRow,
  quantity: number,
  alreadyBought: number,
): 'ok' | 'below-minimum' | 'limit-reached' {
  if (quantity < product.minPurchaseQuantity) return 'below-minimum';
  if (product.purchaseLimitMode === 'none' || product.purchaseLimitQuantity === null) return 'ok';
  const consumed = product.purchaseLimitMode === 'lifetime' ? alreadyBought : 0;
  const remaining = Math.max(0, product.purchaseLimitQuantity - consumed);
  return quantity > remaining ? 'limit-reached' : 'ok';
}

/** The shared product card, for other domains rendering a product in their own list. */
export async function productCardsFor(
  ctx: Ctx,
  productIds: readonly number[],
): Promise<ProductCard[]> {
  const products = await repo.findSellableProducts(ctx.db, productIds);
  const labels = await repo.labelsFor(ctx.db, [...products.keys()]);
  return productIds
    .map((pid) => products.get(pid))
    .filter((row): row is repo.ProductRow => row !== undefined)
    .map((row) => toProductCard(row, labels.get(row.id) ?? []));
}

// ---------------------------------------------------------------------------
// writes shared by create and update
// ---------------------------------------------------------------------------

function productValues(body: AdminProductForm): repo.NewProductValues {
  return {
    name: body.name,
    subtitle: orNull(body.subtitle),
    keyword: orNull(body.keyword),
    spu: orNull(body.spu),
    barCode: orNull(body.barCode),
    kind: body.kind,
    status: body.status,
    imageUrl: body.imageUrl,
    cardImageUrl: orNull(body.cardImageUrl),
    sliderImages: body.sliderImages,
    videoUrl: orNull(body.videoUrl),
    unitName: orNull(body.unitName),
    originalPrice: orNull(body.originalPrice),
    displaySalesBoost: body.displaySalesBoost,
    specMode: body.specMode,
    freightMode: body.freightMode,
    fixedFreight: orNull(body.fixedFreight),
    shippingTemplateId:
      body.shippingTemplateId === undefined ? null : Number(body.shippingTemplateId),
    purchaseLimitMode: body.purchaseLimitMode,
    purchaseLimitQuantity: orNull(body.purchaseLimitQuantity),
    minPurchaseQuantity: body.minPurchaseQuantity,
    isHot: body.isHot,
    isNew: body.isNew,
    isBest: body.isBest,
    isBenefit: body.isBenefit,
    isRecommended: body.isRecommended,
    customForm: body.customForm === undefined ? null : body.customForm.map(toStoredFormField),
    sortOrder: body.sortOrder,
  };
}

/**
 * Drop the keys the operator left empty instead of storing `undefined`.
 *
 * `exactOptionalPropertyTypes` is on, and the column's declared shape says
 * `options?: string[]` — not `string[] | undefined`. Spreading conditionally is
 * the difference between `{"options": null}` and no key at all in the stored
 * JSON, and a storefront renderer may branch on the key being absent.
 */
function toStoredFormField(field: ProductCustomFormField): {
  key: string;
  label: string;
  type: ProductCustomFormField['type'];
  required: boolean;
  options?: string[];
  placeholder?: string;
} {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    ...(field.options === undefined ? {} : { options: field.options }),
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
  };
}

/** Every referenced row must exist, or the whole save is a 404 rather than a half-saved product. */
async function assertLinksExist(tx: Tx, body: AdminProductForm): Promise<void> {
  const categoryIds = body.categoryIds.map(Number);
  const found = await repo.existingCategoryIds(tx, categoryIds);
  if (found.size !== new Set(categoryIds).size) {
    throw new DomainError('CATALOG_CATEGORY_NOT_FOUND');
  }

  const labelIds = body.labelIds.map(Number);
  if (labelIds.length > 0) {
    const labels = await repo.existingLabelIds(tx, labelIds);
    if (labels.size !== new Set(labelIds).size) throw new DomainError('CATALOG_LABEL_NOT_FOUND');
  }

  const protectionIds = body.protectionIds.map(Number);
  if (protectionIds.length > 0) {
    const protections = await repo.existingProtectionIds(tx, protectionIds);
    if (protections.size !== new Set(protectionIds).size) {
      throw new DomainError('CATALOG_PROTECTION_NOT_FOUND');
    }
  }
}

async function writeProductChildren(
  tx: Tx,
  productId: number,
  body: AdminProductForm,
  now: Date,
): Promise<void> {
  await repo.replaceCategoryLinks(tx, productId, body.categoryIds.map(Number));
  await repo.replaceLabelLinks(tx, productId, body.labelIds.map(Number));
  await repo.replaceProtectionLinks(tx, productId, body.protectionIds.map(Number));
  await repo.replaceRecommendations(tx, productId, body.recommendedProductIds.map(Number));
  await repo.replaceGiftCoupons(tx, productId, body.giftCouponIds.map(Number));
  // Sanitised on write, like an article body: the column is served to every
  // shopper, so what it holds must already be safe (kernel/sanitize-html.ts).
  await repo.upsertDescription(tx, {
    productId,
    contentHtml: sanitizeHtml(body.descriptionHtml),
    now,
  });
  await repo.replaceParams(
    tx,
    productId,
    body.params.map((param, index) => ({
      name: param.name,
      value: param.value,
      templateId: param.templateId === null ? null : Number(param.templateId),
      sortOrder: param.sortOrder || index,
    })),
  );
  await repo.replaceSpecs(
    tx,
    productId,
    body.specs.map((spec) => ({
      name: spec.name,
      values: spec.values.map((v) => ({ value: v.value, imageUrl: v.imageUrl ?? null })),
    })),
  );
  await reconcileSkus(tx, productId, body, now);
}

/**
 * Match incoming matrix rows to existing SKUs by spec combination.
 *
 * Kept rows keep their id, stock and sales; new combinations are inserted;
 * combinations the editor removed are deleted. A card product's stock is never
 * taken from the form — the pool decides it — so the insert uses 0 and
 * `syncCardStock` corrects it.
 */
async function reconcileSkus(
  tx: Tx,
  productId: number,
  body: AdminProductForm,
  now: Date,
): Promise<void> {
  const axisOrder = body.specs.map((s) => s.name);
  const existing = await repo.listSkus(tx, productId);
  const byCombo = new Map(existing.map((sku) => [comboKey(sku.specValues), sku]));
  const keptIds = new Set<number>();

  for (const [index, input] of body.skus.entries()) {
    const key = comboKey(input.specValues);
    const specText = specTextOf(input.specValues, axisOrder);
    const match = byCombo.get(key);

    const shared = {
      specText,
      specValues: input.specValues,
      imageUrl: orNull(input.imageUrl),
      price: input.price,
      originalPrice: orNull(input.originalPrice),
      cost: orNull(input.cost),
      barCode: orNull(input.barCode),
      weight: orNull(input.weight),
      volume: orNull(input.volume),
      isDefault: input.isDefault,
      isVisible: input.isVisible,
      sortOrder: input.sortOrder || index,
      updatedAt: now,
    };

    if (match) {
      keptIds.add(match.id);
      // A card SKU's stock is the pool, never the form's.
      const absolute = body.kind !== 'virtual_card' && input.expectedStock === undefined;
      await repo.updateSku(tx, match.id, {
        ...shared,
        ...(absolute ? { stock: input.stock } : {}),
      });
      // The editor says what it was showing. Unchanged: leave the row alone —
      // orders may have moved it since, and writing the old number back would
      // hand those units out a second time. Changed: only over the number the
      // operator actually saw.
      if (
        body.kind !== 'virtual_card' &&
        input.expectedStock !== undefined &&
        input.stock !== input.expectedStock
      ) {
        const { won } = await repo.setSkuStockIf(tx, {
          id: match.id,
          expected: input.expectedStock,
          next: input.stock,
        });
        if (!won) {
          const current = (await repo.listSkus(tx, productId)).find((s) => s.id === match.id);
          throw new DomainError('CATALOG_SKU_STOCK_CHANGED', {
            details: { specText, expected: input.expectedStock, current: current?.stock ?? null },
          });
        }
      }
    } else {
      const inserted = await repo.insertSku(tx, {
        ...shared,
        productId,
        skuCode: input.skuCode ?? (await uniqueSkuCode(tx)),
        stock: body.kind === 'virtual_card' ? 0 : input.stock,
        sales: 0,
        createdAt: now,
      });
      keptIds.add(inserted.id);
    }
  }

  // The pool is the stock of every card SKU, kept or new — including SKUs of
  // a product that just became a card product, whose old typed stock would
  // otherwise sell cards that do not exist.
  if (body.kind === 'virtual_card') {
    for (const skuId of keptIds) await repo.syncCardStock(tx, skuId);
  }

  const dropped = existing.filter((sku) => !keptIds.has(sku.id));
  try {
    await repo.deleteSkus(
      tx,
      dropped.map((sku) => sku.id),
    );
  } catch (error) {
    // `order_items`, group-buy and presale SKUs all RESTRICT: a combination
    // somebody bought stays, and the operator is told to hide it instead.
    if (isForeignKeyViolation(error)) {
      throw new DomainError('CATALOG_SKU_IN_USE', {
        details: { specTexts: dropped.map((sku) => sku.specText) },
      });
    }
    throw error;
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === '23503' || causeCode === '23503';
}

/**
 * A free SKU code.
 *
 * `product_skus_code_uq` is the real guarantee; this loop only keeps the error
 * out of the operator's face. Twelve random characters from a 32-letter
 * alphabet is far more entropy than a shop will ever exhaust, so the retry is
 * effectively dead code — but "effectively" is not "provably", and a unique
 * index violation on save would lose the whole form.
 */
async function uniqueSkuCode(tx: Tx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = skuCodeFrom(randomBytes(10));
    if ((await repo.findSkuByCode(tx, code)) === null) return code;
  }
  throw new DomainError('INTERNAL', { message: '无法生成唯一的规格编码' });
}

// ---------------------------------------------------------------------------
// row -> DTO
// ---------------------------------------------------------------------------

export function toCategory(row: repo.CategoryRow, productCount: number): ProductCategory {
  return {
    id: String(row.id),
    parentId: row.parentId === null ? null : String(row.parentId),
    name: row.name,
    path: row.path,
    level: row.level,
    iconUrl: row.iconUrl,
    bannerUrl: row.bannerUrl,
    sortOrder: row.sortOrder,
    isVisible: row.isVisible,
    productCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export function buildCategoryTree(
  rows: readonly repo.CategoryRow[],
  counts: ReadonlyMap<number, number>,
): ProductCategoryNode[] {
  const childrenOf = (parentId: number | null) =>
    rows
      .filter((row) => row.parentId === parentId)
      .map((row) => toCategory(row, counts.get(row.id) ?? 0));

  return childrenOf(null).map((root) => ({
    ...root,
    children: childrenOf(Number(root.id)).map((branch) => ({
      ...branch,
      children: childrenOf(Number(branch.id)),
    })),
  }));
}

export function toCardLabel(row: repo.LabelRow): ProductCardLabel {
  return {
    id: String(row.id),
    name: row.name,
    style: row.style,
    fontColor: row.fontColor,
    backgroundColor: row.backgroundColor,
    borderColor: row.borderColor,
    imageUrl: row.imageUrl,
  };
}

export function toProductCard(row: repo.ProductRow, labels: readonly repo.LabelRow[]): ProductCard {
  return {
    id: String(row.id),
    name: row.name,
    subtitle: row.subtitle,
    imageUrl: row.imageUrl,
    cardImageUrl: row.cardImageUrl,
    price: row.price,
    originalPrice: row.originalPrice,
    stock: row.stock,
    salesDisplay: salesDisplay(row.sales, row.displaySalesBoost),
    unitName: row.unitName,
    kind: row.kind,
    labels: labels.filter((label) => label.isVisible && label.isEnabled).map(toCardLabel),
    canAddToCart: canAddToCart({
      kind: row.kind,
      hasCustomForm: (row.customForm?.length ?? 0) > 0,
    }),
  };
}

export function toSku(row: repo.SkuRow): ProductSku {
  return {
    id: String(row.id),
    skuCode: row.skuCode,
    specText: row.specText,
    specValues: row.specValues,
    imageUrl: row.imageUrl,
    price: row.price,
    originalPrice: row.originalPrice,
    cost: row.cost,
    stock: row.stock,
    sales: row.sales,
    barCode: row.barCode,
    weight: row.weight,
    volume: row.volume,
    isDefault: row.isDefault,
    isVisible: row.isVisible,
    sortOrder: row.sortOrder,
  };
}

function toSpec(entry: { spec: repo.SpecRow; values: repo.SpecValueRow[] }): ProductSpec {
  return {
    id: String(entry.spec.id),
    name: entry.spec.name,
    sortOrder: entry.spec.sortOrder,
    values: entry.values.map((value) => ({
      id: String(value.id),
      value: value.value,
      imageUrl: value.imageUrl,
      sortOrder: value.sortOrder,
    })),
  };
}

/**
 * 成本价 is the shop's margin. The editor sets it, so `product:write` sees it,
 * and the export carries it, so `product:export` does; a role that may only
 * look at products (support, say) gets `null`. It cannot save, so a `null` it
 * never sends back cannot wipe anything.
 */
function seesCost(ctx: Ctx): boolean {
  return (
    hasPermission(ctx.actor, catalogPermissions['product:write']) ||
    hasPermission(ctx.actor, catalogPermissions['product:export'])
  );
}

/** The list shape, with the two batched lookups every row needs. */
async function decorateProducts(
  db: DbOrTx,
  rows: readonly repo.ProductRow[],
  showCost: boolean,
): Promise<AdminProductListItem[]> {
  const ids = rows.map((r) => r.id);
  const [categoryIds, labels] = await Promise.all([
    repo.categoryIdsFor(db, ids),
    repo.labelsFor(db, ids),
  ]);
  const names = await repo.categoryNames(db, [...new Set([...categoryIds.values()].flat())]);

  return rows.map((row) => {
    const linked = categoryIds.get(row.id) ?? [];
    return {
      ...toProductCard(row, labels.get(row.id) ?? []),
      spu: row.spu,
      status: row.status,
      cost: showCost ? row.cost : null,
      sales: row.sales,
      displaySalesBoost: row.displaySalesBoost,
      views: row.views,
      specMode: row.specMode,
      isHot: row.isHot,
      isNew: row.isNew,
      isBest: row.isBest,
      isBenefit: row.isBenefit,
      isRecommended: row.isRecommended,
      sortOrder: row.sortOrder,
      categoryIds: linked.map(String),
      categoryNames: linked.map((cid) => names.get(cid) ?? '').filter(Boolean),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
    } satisfies AdminProductListItem;
  });
}

async function buildProductDetail(
  ctx: Ctx,
  row: repo.ProductRow,
  tx?: Tx,
): Promise<AdminProductDetail> {
  const db = tx ?? ctx.db;
  const showCost = seesCost(ctx);
  const [listItem] = await decorateProducts(db, [row], showCost);
  const [specs, skus, params, links, descriptionHtml] = await Promise.all([
    repo.listSpecs(db, row.id),
    repo.listSkus(db, row.id),
    repo.listParams(db, row.id),
    repo.linkedIds(db, row.id),
    repo.findDescription(db, row.id),
  ]);

  return {
    ...listItem!,
    keyword: row.keyword,
    barCode: row.barCode,
    cardImageUrl: row.cardImageUrl,
    sliderImages: row.sliderImages,
    videoUrl: row.videoUrl,
    unitName: row.unitName,
    freightMode: row.freightMode,
    fixedFreight: row.fixedFreight,
    shippingTemplateId: row.shippingTemplateId === null ? null : String(row.shippingTemplateId),
    purchaseLimitMode: row.purchaseLimitMode,
    purchaseLimitQuantity: row.purchaseLimitQuantity,
    minPurchaseQuantity: row.minPurchaseQuantity,
    customForm: row.customForm,
    descriptionHtml,
    specs: specs.map(toSpec),
    skus: skus.map((sku) => (showCost ? toSku(sku) : { ...toSku(sku), cost: null })),
    params: params.map((param) => ({
      id: String(param.id),
      name: param.name,
      value: param.value,
      templateId: param.templateId === null ? null : String(param.templateId),
    })),
    protectionIds: links.protectionIds.map(String),
    labelIds: links.labelIds.map(String),
    recommendedProductIds: links.recommendedProductIds.map(String),
    giftCouponIds: links.giftCouponIds.map(String),
  };
}
