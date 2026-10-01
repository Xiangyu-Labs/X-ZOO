import type {
  CartAddBody,
  CartCount,
  CartItem,
  CartList,
  CartListQuery,
  CartMutationResult,
  CartRebuyBody,
  CartRebuyResult,
  CartRemoveBody,
  CartSelectionBody,
  CartUpdateBody,
} from '@shop/contracts/cart/schemas';
import type { DbOrTx, Tx } from '@shop/db';
import { recordCartAdd } from '../catalog';
import { requireUserId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId } from '../kernel/ids';
import { Money } from '../kernel/money';
import { rebuyLines, resolveCatalogPort, type SkuForSale } from '../order';
import { getOrderFacts } from '../order/ports';
import * as repo from './cart.repo';
import {
  MAX_CART_ROWS,
  capFor,
  isAvailable,
  quantityRuleOf,
  refuseQuantity,
  stateOf,
  type QuantityRefusal,
} from './cart.rules';

/**
 * The cart.
 *
 * Two decisions shape every function here.
 *
 * **Nothing about a product is stored on the cart row.** The row is
 * `(user, sku, quantity, isSelected)`; the name, the picture, the price and the
 * stock are read live through the catalogue port every time the cart is listed.
 * A copy of the product on the row would need a scheduled task to keep it in
 * step with the product table, and is how a shopper gets shown — and charged —
 * last month's price.
 *
 * **An unsellable row is shown, not deleted.** `stateOf` says why it cannot be
 * checked out, the storefront greys it out, and 清空失效商品 removes them when
 * the shopper asks.
 */

interface EnrichedRow {
  row: repo.CartRow;
  sku: SkuForSale | undefined;
  state: ReturnType<typeof stateOf>;
  quantityRule: ReturnType<typeof quantityRuleOf>;
  available: boolean;
  unitPrice: Money;
  subtotal: Money;
}

async function loadCart(ctx: Ctx, db: DbOrTx, userId: number): Promise<EnrichedRow[]> {
  const rows = await repo.listByUser(db, { userId, limit: MAX_CART_ROWS });
  const skus = await resolveCatalogPort().getSkusForSale(
    db,
    rows.map((row) => row.skuId),
  );
  const purchased = await lifetimePurchases(db, userId, [...skus.values()]);
  return rows.map((row) => {
    const sku = skus.get(row.skuId);
    const bought = sku ? (purchased.get(sku.productId) ?? 0) : 0;
    const state = stateOf(sku, row.quantity, bought);
    const unitPrice = sku ? Money.parse(sku.unitPrice) : Money.ZERO;
    return {
      row,
      sku,
      state,
      quantityRule: quantityRuleOf(sku, row.quantity, bought),
      available: isAvailable(state),
      unitPrice,
      subtotal: unitPrice.mul(row.quantity),
    };
  });
}

/**
 * Units already bought of each product in the cart that has a `lifetime`
 * limit, through the order domain's facts port (one read per such product;
 * a cart rarely holds more than a few).
 */
async function lifetimePurchases(
  db: DbOrTx,
  userId: number,
  skus: readonly SkuForSale[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const products = new Set(
    skus
      .filter((sku) => sku.purchaseLimitMode === 'lifetime' && sku.purchaseLimitQuantity !== null)
      .map((sku) => sku.productId),
  );
  for (const productId of products) {
    // The port is typed for a transaction; a plain read through the pool is the same query.
    out.set(productId, await getOrderFacts().purchasedQuantity(db as Tx, { userId, productId }));
  }
  return out;
}

function toCartItem(entry: EnrichedRow): CartItem {
  const sku = entry.sku;
  return {
    id: toId(entry.row.id),
    productId: toId(entry.row.productId),
    skuId: toId(entry.row.skuId),
    quantity: entry.row.quantity,
    isSelected: entry.row.isSelected,
    available: entry.available,
    state: entry.state,
    // A deleted variant has no live data left; the row still has to render so
    // the shopper can remove it.
    productName: sku?.productName ?? '商品已下架',
    productImageUrl: sku?.productImageUrl ?? '',
    productKind: sku?.productKind ?? 'physical',
    skuImageUrl: sku?.skuImageUrl ?? null,
    specText: sku?.specText ?? '',
    unitName: sku?.unitName ?? null,
    unitPrice: entry.unitPrice.toString(),
    originalUnitPrice: sku?.originalUnitPrice ?? null,
    subtotal: entry.subtotal.toString(),
    stock: sku?.stock ?? 0,
    quantityRule: entry.quantityRule,
    createdAt: entry.row.createdAt.toISOString(),
  };
}

function countOf(entries: readonly EnrichedRow[]): CartCount {
  const availableCount = entries.filter((entry) => entry.available).length;
  return {
    items: entries.length,
    quantity: entries.reduce((sum, entry) => sum + entry.row.quantity, 0),
    availableCount,
    unavailableCount: entries.length - availableCount,
  };
}

function listOf(entries: readonly EnrichedRow[], query: CartListQuery): CartList {
  const filtered = entries.filter((entry) =>
    query.filter === 'available'
      ? entry.available
      : query.filter === 'unavailable'
        ? !entry.available
        : true,
  );
  const start = (query.page - 1) * query.pageSize;
  const selected = entries.filter((entry) => entry.available && entry.row.isSelected);

  return {
    items: filtered.slice(start, start + query.pageSize).map(toCartItem),
    total: filtered.length,
    page: query.page,
    pageSize: query.pageSize,
    availableCount: entries.filter((entry) => entry.available).length,
    unavailableCount: entries.filter((entry) => !entry.available).length,
    // Ticked *and* sellable: an out-of-stock row the shopper ticked last week
    // must not inflate what the 结算 button says.
    selectedQuantity: selected.reduce((sum, entry) => sum + entry.row.quantity, 0),
    selectedTotal: Money.sum(selected.map((entry) => entry.subtotal)).toString(),
  };
}

function refuse(refusal: QuantityRefusal): never {
  throw new DomainError(
    refusal.code,
    refusal.details === undefined ? {} : { details: refusal.details },
  );
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function list(ctx: Ctx, query: CartListQuery): Promise<CartList> {
  const userId = requireUserId(ctx);
  return listOf(await loadCart(ctx, ctx.db, userId), query);
}

export async function count(ctx: Ctx): Promise<CartCount> {
  const userId = requireUserId(ctx);
  return countOf(await loadCart(ctx, ctx.db, userId));
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

async function skuOrRefuse(ctx: Ctx, db: DbOrTx, skuId: number): Promise<SkuForSale> {
  const skus = await resolveCatalogPort().getSkusForSale(db, [skuId]);
  const sku = skus.get(skuId);
  if (!sku || sku.deleted || !sku.onSale) throw new DomainError('CART_SKU_NOT_AVAILABLE');
  return sku;
}

/**
 * 加入购物车. Adding is **relative** — two taps of `1` leave `2` — which is
 * what the button means, and it is one `INSERT … ON CONFLICT DO UPDATE`, so two
 * devices tapping at once end at the sum rather than at two rows.
 *
 * The limit check reads the current quantity first, which is a read-then-write
 * and is deliberately only advisory: the hard cap rides along in the same
 * statement as `least(quantity + n, cap)`, so the worst a lost race can do is
 * report success at the cap instead of a refusal.
 */
export async function addItem(ctx: Ctx, body: CartAddBody): Promise<CartMutationResult> {
  const userId = requireUserId(ctx);
  const skuId = fromId(body.skuId);

  const entries = await ctx.withTx(async (tx) => {
    const sku = await skuOrRefuse(ctx, tx, skuId);
    const existing = await repo.findBySku(tx, { userId, skuId });
    const wanted = (existing?.quantity ?? 0) + body.quantity;

    const refusal = refuseQuantity(sku, wanted);
    if (refusal) refuse(refusal);

    await repo.addUnits(tx, {
      userId,
      productId: sku.productId,
      skuId,
      quantity: body.quantity,
      cap: capFor(sku),
    });
    // 加购件数 on the stats product page. In the same transaction as the row it
    // describes, and through the catalog's seam rather than this domain's repo,
    // because `product_events` is a catalog table.
    await recordCartAdd(tx, ctx, {
      productId: sku.productId,
      skuId,
      userId,
      quantity: body.quantity,
    });
    return loadCart(ctx, tx, userId);
  });

  const entry = entries.find((candidate) => candidate.row.skuId === skuId);
  return { item: entry ? toCartItem(entry) : null, cart: countOf(entries) };
}

/**
 * Absolute quantity, the tick, and/or 修改规格. `PATCH`, because it is a partial
 * edit.
 *
 * ## Changing the variant
 *
 * 修改规格 as `DELETE` then `POST` from the storefront would lose the row
 * outright if the second call failed. Here it is one transaction, and it is
 * deliberately written as *remove the old row, then add the units under the new
 * variant* rather than as `UPDATE … SET sku_id = …`:
 *
 *  - `addUnits` is a single `INSERT … ON CONFLICT (user_id, sku_id) DO UPDATE`,
 *    so folding into a row the cart already holds is the database's decision
 *    and cannot race with a concurrent add of the same variant. An in-place
 *    `UPDATE` would instead hit `cart_items_user_sku_uq` and abort the whole
 *    transaction;
 *  - the delete is conditional, so of two requests moving the same row only one
 *    re-adds the units.
 *
 * The cost is that the surviving row's `id` is not the one that was PATCHed
 * when there was no row to merge into. The contract says so and the answer
 * carries the survivor, which is what the storefront re-renders anyway.
 */
export async function updateItem(
  ctx: Ctx,
  params: { id: string },
  body: CartUpdateBody,
): Promise<CartMutationResult> {
  const userId = requireUserId(ctx);
  const id = fromId(params.id);
  const wantedSkuId = body.skuId === undefined ? null : fromId(body.skuId);

  const changed = await ctx.withTx(async (tx) => {
    const row = await repo.findForUser(tx, { id, userId });
    if (!row) throw new DomainError('CART_ITEM_NOT_FOUND');

    let survivingId = id;

    if (wantedSkuId !== null && wantedSkuId !== row.skuId) {
      survivingId = await changeSku(ctx, tx, {
        row,
        userId,
        skuId: wantedSkuId,
        quantity: body.quantity ?? row.quantity,
      });
    } else if (body.quantity !== undefined) {
      const sku = await skuOrRefuse(ctx, tx, row.skuId);
      const refusal = refuseQuantity(sku, body.quantity);
      if (refusal) refuse(refusal);
      const moved = await repo.setQuantity(tx, { id, userId, quantity: body.quantity });
      if (!moved.won) throw new DomainError('CART_ITEM_NOT_FOUND');
    }

    if (body.isSelected !== undefined) {
      await repo.setSelected(tx, { userId, ids: [survivingId], isSelected: body.isSelected });
    }
    return { survivingId, entries: await loadCart(ctx, tx, userId) };
  });

  const entry = changed.entries.find((candidate) => candidate.row.id === changed.survivingId);
  return { item: entry ? toCartItem(entry) : null, cart: countOf(changed.entries) };
}

/**
 * The variant half of `updateItem`. Answers with the id of the row that now
 * holds the units — the merge target when the cart already had that variant,
 * otherwise a fresh row.
 *
 * The quantity checked is the **total** the shopper will end up with, because
 * that is the number the purchase limit and the stock are about: moving 2 units
 * onto a variant the cart already holds 3 of asks for 5, and 5 is what has to
 * pass `refuseQuantity`.
 */
async function changeSku(
  ctx: Ctx,
  tx: Tx,
  args: { row: repo.CartRow; userId: number; skuId: number; quantity: number },
): Promise<number> {
  const sku = await skuOrRefuse(ctx, tx, args.skuId);
  const existing = await repo.findBySku(tx, { userId: args.userId, skuId: args.skuId });

  const refusal = refuseQuantity(sku, args.quantity + (existing?.quantity ?? 0));
  if (refusal) refuse(refusal);

  // Conditional: the row we are about to move must still be there. Two devices
  // re-speccing the same row therefore move it once, and the loser is told the
  // row is gone rather than silently duplicating its units.
  const removed = await repo.removeOne(tx, { id: args.row.id, userId: args.userId });
  if (!removed.won) throw new DomainError('CART_ITEM_NOT_FOUND');

  const survivor = await repo.addUnits(tx, {
    userId: args.userId,
    productId: sku.productId,
    skuId: args.skuId,
    quantity: args.quantity,
    cap: capFor(sku),
  });
  return survivor.id;
}

export async function removeItem(ctx: Ctx, params: { id: string }): Promise<CartMutationResult> {
  const userId = requireUserId(ctx);
  const id = fromId(params.id);

  const entries = await ctx.withTx(async (tx) => {
    const removed = await repo.remove(tx, { userId, ids: [id] });
    if (removed === 0) throw new DomainError('CART_ITEM_NOT_FOUND');
    return loadCart(ctx, tx, userId);
  });
  return { item: null, cart: countOf(entries) };
}

/** Bulk delete, and 清空失效商品 behind the same route. */
export async function removeItems(
  ctx: Ctx,
  body: CartRemoveBody,
): Promise<{ removed: number; cart: CartCount }> {
  const userId = requireUserId(ctx);

  return ctx.withTx(async (tx) => {
    const ids = body.unavailableOnly
      ? (await loadCart(ctx, tx, userId))
          .filter((entry) => !entry.available)
          .map((entry) => entry.row.id)
      : body.itemIds.map(fromId);
    const removed = await repo.remove(tx, { userId, ids });
    return { removed, cart: countOf(await loadCart(ctx, tx, userId)) };
  });
}

/**
 * Ticking rows.
 *
 * 全选 ticks every **available** row and never a dead one, which would only
 * put it back into the 结算 total the next time the shopper looked. 全不选
 * clears every row, dead ones included — leaving a ticked corpse behind would
 * mean 全不选 did not do what it says.
 */
export async function setSelection(ctx: Ctx, body: CartSelectionBody): Promise<CartList> {
  const userId = requireUserId(ctx);

  const entries = await ctx.withTx(async (tx) => {
    const loaded = await loadCart(ctx, tx, userId);
    const ids = body.all
      ? loaded
          .filter((entry) => (body.isSelected ? entry.available : true))
          .map((entry) => entry.row.id)
      : body.itemIds.map(fromId);
    await repo.setSelected(tx, { userId, ids, isSelected: body.isSelected });
    return loadCart(ctx, tx, userId);
  });

  // The whole cart, not a first page: the storefront puts this answer in place of the cart it
  // shows, and a 20-row page would drop every row past the 20th from it.
  return listOf(entries, { page: 1, pageSize: MAX_CART_ROWS, filter: 'all' });
}

/**
 * 再次购买.
 *
 * Reports rather than refuses: products go off shelf, and a partial result is
 * the normal case. The lines come from the order domain — the cart may not
 * read `order_items` itself — and each one is put back with the same relative
 * add the 加入购物车 button uses.
 */
export async function rebuy(ctx: Ctx, body: CartRebuyBody): Promise<CartRebuyResult> {
  const userId = requireUserId(ctx);
  const lines = await rebuyLines(ctx, { orderId: fromId(body.orderId), userId });

  return ctx.withTx(async (tx) => {
    const skus = await resolveCatalogPort().getSkusForSale(
      tx,
      lines.map((line) => line.skuId),
    );
    const skipped: string[] = [];
    let added = 0;

    for (const line of lines) {
      const sku = skus.get(line.skuId);
      if (!sku || sku.deleted || !sku.onSale || sku.stock < 1) {
        skipped.push(toId(line.skuId));
        continue;
      }
      const quantity = Math.min(line.quantity, capFor(sku), Math.max(1, sku.stock));
      await repo.addUnits(tx, {
        userId,
        productId: sku.productId,
        skuId: sku.skuId,
        quantity,
        cap: capFor(sku),
      });
      added += 1;
    }

    return { added, skippedSkuIds: skipped, cart: countOf(await loadCart(ctx, tx, userId)) };
  });
}
