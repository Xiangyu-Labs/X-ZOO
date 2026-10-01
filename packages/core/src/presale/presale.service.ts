import type { PageQuery } from '@shop/contracts/conventions';
import type {
  PresaleActivityDetail,
  PresaleActivityForm,
  PresaleActivityListItem,
  PresaleActivityListQuery,
  PresaleActivityStatusBody,
  PresaleCard,
  PresaleDetail,
  PresaleListQuery,
  PresaleOrderItem,
  PresaleOrderListQuery,
} from '@shop/contracts/presale/schemas';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { resolveActivityStocks } from '../kernel/stock-edit';
import { toId, toIdOrNull } from '../kernel/ids';
import * as repo from './presale.repo';
import { assertFullPayment, canBuy } from './presale.rules';

/**
 * Presale services: everything a route file calls.
 *
 * The service decides, the repo states: every `if` about an affected row count
 * is here; every SQL statement is in `presale.repo.ts`. What is *not* here is
 * buying a presale item: that is an order, and it lives in `presale.order.ts`
 * behind the order domain's seams.
 *
 * The admin surface is audited for free: `handle()` writes an `audit_logs` row
 * for every mutating admin route, so an operator shortening a 发货承诺 is on the
 * record without this file writing a line.
 */

type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

// ---------------------------------------------------------------------------
// admin — activities
// ---------------------------------------------------------------------------

export async function adminActivityList(
  ctx: Ctx,
  query: PresaleActivityListQuery,
): Promise<Paged<PresaleActivityListItem>> {
  const { rows, total } = await repo.listActivities(ctx.db, {
    keyword: query.keyword,
    statuses: asArray(query.status),
    productId: query.productId === undefined ? undefined : Number(query.productId),
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  return { items: rows.map(toListItem), total, page: query.page, pageSize: query.pageSize };
}

export async function adminActivityDetail(
  ctx: Ctx,
  input: { id: string },
): Promise<PresaleActivityDetail> {
  return toDetail(ctx, await mustFindActivity(ctx, Number(input.id)));
}

export async function adminActivityCreate(
  ctx: Ctx,
  body: PresaleActivityForm,
): Promise<PresaleActivityDetail> {
  return ctx.withTx(async (tx) => {
    assertFullPayment(body);
    await assertSkusBelongToProduct(tx, body);
    const now = ctx.clock.now();
    const row = await repo.insertActivity(tx, {
      ...activityValues(body),
      createdAt: now,
      updatedAt: now,
    });
    await repo.replaceActivitySkus(tx, { activityId: row.id, skus: skuValues(body) });
    return toDetail(ctx, await mustFindActivity(ctx, row.id, tx), tx);
  });
}

/**
 * Edit.
 *
 * `shipAfterDays` is copied onto every order when it is *paid*
 * (`presale_orders.ship_not_before_at`), so shortening or lengthening it
 * mid-campaign cannot move a promise already made to a shopper. That is the
 * whole reason the column is duplicated on the order row: without it, a
 * shopper's 15-day presale suddenly says 30 days.
 */
export async function adminActivityUpdate(
  ctx: Ctx,
  input: { id: string },
  body: PresaleActivityForm,
): Promise<PresaleActivityDetail> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    assertFullPayment(body);
    const locked = await repo.lockActivityStock(tx, id);
    if (!locked) throw new DomainError('PRESALE_ACTIVITY_NOT_FOUND');
    // `ended` is terminal (see `adminActivitySetStatus`): the form cannot re-open it either.
    if (locked.status === 'ended' && body.status !== 'ended') {
      throw new DomainError('PRESALE_ACTIVITY_ENDED');
    }
    await assertSkusBelongToProduct(tx, body);
    const skus = skuValues(body);
    // RISK-D-012: a SKU orders still point at is switched off, never removed.
    const inUse = await repo.listRemovedSkusInUse(tx, {
      activityId: id,
      keep: skus.map((sku) => sku.skuId),
    });
    if (inUse.length > 0) {
      throw new DomainError('PRESALE_ACTIVITY_SKU_IN_USE', {
        details: { skuIds: inUse.map(String) },
      });
    }
    // Orders moved these counters while the form was open; see `resolveStockEdit`.
    const stocks = resolveActivityStocks(
      locked,
      { stock: body.stock, expectedStock: body.expectedStock, skus: expectedOf(body, skus) },
      'PRESALE_STOCK_CHANGED',
    );
    const now = ctx.clock.now();
    const moved = await repo.updateActivity(tx, id, {
      ...activityValues(body),
      stock: stocks.stock,
      updatedAt: now,
    });
    if (!moved.won) throw new DomainError('PRESALE_ACTIVITY_NOT_FOUND');
    await repo.replaceActivitySkus(tx, {
      activityId: id,
      skus: skus.map((sku) => ({ ...sku, stock: stocks.skuStocks.get(sku.skuId) ?? sku.stock })),
    });
    return toDetail(ctx, await mustFindActivity(ctx, id, tx), tx);
  });
}

export async function adminActivitySetStatus(
  ctx: Ctx,
  input: { id: string },
  body: PresaleActivityStatusBody,
): Promise<PresaleActivityDetail> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const moved = await repo.setActivityStatus(tx, {
      id,
      // `ended` is terminal: an expired campaign is not re-opened, it is copied.
      // The window sweep relies on this too — a closed campaign it re-opened
      // would be closed again a minute later, forever.
      from: ['draft', 'active', 'paused'],
      to: body.status,
      now: ctx.clock.now(),
    });
    if (!moved.won) {
      const existing = await repo.findActivity(tx, id);
      if (!existing) throw new DomainError('PRESALE_ACTIVITY_NOT_FOUND');
      throw new DomainError('PRESALE_ACTIVITY_NOT_OPEN', { details: { status: existing.status } });
    }
    return toDetail(ctx, await mustFindActivity(ctx, id, tx), tx);
  });
}

/**
 * Soft delete, refused while an order still owes goods.
 *
 * Deleting the campaign outright would leave every live presale order pointing
 * at nothing, and the 预售订单 screen showing an empty card. The foreign key is
 * `ON DELETE RESTRICT` and this guard gives the operator a sentence instead of
 * a constraint error.
 */
export async function adminActivityDelete(ctx: Ctx, input: { id: string }): Promise<void> {
  const id = Number(input.id);
  await ctx.withTx(async (tx) => {
    await mustFindActivity(ctx, id, tx);
    const live = await repo.countLiveOrders(tx, id);
    if (live > 0) {
      throw new DomainError('PRESALE_ACTIVITY_IN_USE', { details: { liveOrders: live } });
    }
    await repo.softDeleteActivity(tx, { id, now: ctx.clock.now() });
  });
}

// ---------------------------------------------------------------------------
// admin — orders
// ---------------------------------------------------------------------------

/**
 * 预售订单.
 *
 * One row per presale order, with the two dates an operator is actually asked
 * about on the phone: when the money landed and the earliest the parcel may
 * leave. Both are frozen on the order row, so this list never recomputes a
 * promise from today's campaign settings.
 */
export async function adminOrderList(
  ctx: Ctx,
  query: PresaleOrderListQuery,
): Promise<Paged<PresaleOrderItem>> {
  const { rows, total } = await repo.listPresaleOrders(ctx.db, {
    activityId: query.activityId === undefined ? undefined : Number(query.activityId),
    stages: asArray(query.stage),
    userId: query.userId === undefined ? undefined : Number(query.userId),
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  return {
    items: rows.map((row) => ({
      orderId: toId(row.orderId),
      orderNo: row.orderNo,
      activityId: toId(row.activityId),
      activityTitle: row.activityTitle,
      userId: toId(row.userId),
      nickname: row.nickname,
      paymentMode: row.paymentMode,
      stage: row.stage,
      quantity: row.quantity,
      payableAmount: row.payableAmount,
      finalAmount: row.finalAmount,
      finalPaidAt: row.finalPaidAt?.toISOString() ?? null,
      finalDueAt: row.finalDueAt?.toISOString() ?? null,
      shipNotBeforeAt: row.shipNotBeforeAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/presale/activities`: the 预售 channel list, or with `ids` a DIY
 * 预售 component's 指定数据 — those activities in the order saved, the
 * invisible skipped (`cardsFor`), then paged. `ids` and `productId` together
 * are the intersection: the picked activities that are that product's.
 */
export async function list(ctx: Ctx, query: PresaleListQuery): Promise<Paged<PresaleCard>> {
  if (query.ids !== undefined) {
    const cards = await cardsFor(ctx, query.ids, { productId: query.productId });
    const from = (query.page - 1) * query.pageSize;
    return {
      items: cards.slice(from, from + query.pageSize),
      total: cards.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  const now = ctx.clock.now();
  const { rows, total } = await repo.listActivities(ctx.db, {
    visibleAt: now,
    productId: query.productId === undefined ? undefined : Number(query.productId),
    sortBy: 'sortOrder',
    sortOrder: 'desc',
    ...pageBounds(query),
  });
  return {
    items: rows.map((row) => toCard(row, now)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * The storefront cards of exactly these activities, in the order given — what
 * a DIY 预售 block's manual pick shows. Read-only and additive: the same
 * visibility as `list` (active, inside its window, not deleted), so an id the
 * shopper could not see there is skipped here, as is a malformed or repeated
 * one. At most `DECOR_LIMITS.records` ids arrive, so one query answers it.
 */
export async function cardsFor(
  ctx: Ctx,
  ids: readonly string[],
  options: { productId?: string | undefined } = {},
): Promise<PresaleCard[]> {
  const wanted = [...new Set(ids.filter((id) => /^[1-9]\d{0,14}$/.test(id)))].map(Number);
  if (wanted.length === 0) return [];
  const now = ctx.clock.now();
  const { rows } = await repo.listActivities(ctx.db, {
    visibleAt: now,
    ids: wanted,
    productId: options.productId === undefined ? undefined : Number(options.productId),
    limit: wanted.length,
    offset: 0,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return wanted.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toCard(row, now)] : [];
  });
}

/** The statuses whose page a shopper may open. Everything else is a 404. */
const STOREFRONT_READABLE: ReadonlySet<repo.ActivityRow['status']> = new Set([
  'active',
  'paused',
  'ended',
]);

export async function detail(ctx: Ctx, input: { id: string }): Promise<PresaleDetail> {
  const id = Number(input.id);
  const now = ctx.clock.now();
  const activity = await repo.findActivity(ctx.db, id);
  // A draft is not on the storefront, not even by id: ids are sequential, and
  // the form promises 「草稿不会出现在前台」. `paused` and `ended` stay
  // readable — orders link to the page — and `canBuy` says no.
  if (!activity || !STOREFRONT_READABLE.has(activity.status)) {
    throw new DomainError('PRESALE_ACTIVITY_NOT_FOUND');
  }

  const [skus, description] = await Promise.all([
    repo.listActivitySkus(ctx.db, [id]),
    repo.findProductDescription(ctx.db, activity.productId),
  ]);

  return {
    ...toCard(activity, now),
    sliderImages: activity.sliderImages,
    perOrderQuantity: activity.perOrderQuantity,
    description,
    skus: skus
      .filter((sku) => sku.isEnabled)
      .map((sku) => ({
        skuId: toId(sku.skuId),
        specText: sku.specText,
        specValues: sku.specValues,
        imageUrl: sku.imageUrl,
        price: sku.price,
        // The struck-through price is the catalogue's, not the campaign's:
        // showing 预售价 twice would be a discount of nothing.
        originalPrice: sku.skuOriginalPrice ?? sku.skuPrice,
        stock: sku.stock,
      })),
  };
}

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

async function mustFindActivity(
  ctx: Ctx,
  id: number,
  tx?: Parameters<typeof repo.findActivity>[0],
): Promise<repo.ActivityRow> {
  const row = await repo.findActivity(tx ?? ctx.db, id);
  if (!row) throw new DomainError('PRESALE_ACTIVITY_NOT_FOUND');
  return row;
}

/**
 * A SKU the form names must really belong to the product. Without this an
 * operator (or a hand-crafted body) could attach a 1 元 presale price to
 * somebody else's SKU and the `product_skus` join would happily serve it.
 */
async function assertSkusBelongToProduct(
  tx: Parameters<typeof repo.skuIdsOfProduct>[0],
  body: PresaleActivityForm,
): Promise<void> {
  if (body.skus.length === 0) return;
  const owned = new Set(await repo.skuIdsOfProduct(tx, Number(body.productId)));
  for (const sku of body.skus) {
    if (!owned.has(Number(sku.skuId))) {
      throw new DomainError('PRESALE_SKU_NOT_IN_ACTIVITY', { details: { skuId: sku.skuId } });
    }
  }
}

/**
 * The form's values as columns.
 *
 * The four deposit columns are written as `null` unconditionally:
 * `presale_activities_deposit_shape` insists a `full` campaign has no deposit
 * and no balance window, and the contract refuses `paymentMode: 'deposit'`
 * before we get here. Spelling them out beats relying on the default, because
 * an *edit* of a migrated deposit campaign has to clear them.
 */
function activityValues(body: PresaleActivityForm) {
  return {
    productId: Number(body.productId),
    title: body.title,
    intro: body.intro ?? null,
    imageUrl: body.imageUrl ?? null,
    sliderImages: body.sliderImages,
    status: body.status,
    paymentMode: 'full' as const,
    price: body.price,
    originalPrice: body.originalPrice ?? null,
    depositAmount: null,
    stock: body.stock,
    totalQuota: body.totalQuota ?? null,
    perOrderQuantity: body.perOrderQuantity,
    startAt: new Date(body.startAt),
    endAt: new Date(body.endAt),
    finalPaymentStartAt: null,
    finalPaymentEndAt: null,
    shipAfterDays: body.shipAfterDays,
    shippingTemplateId:
      body.shippingTemplateId === undefined ? null : Number(body.shippingTemplateId),
    sortOrder: body.sortOrder,
  };
}

function skuValues(body: PresaleActivityForm): repo.ActivitySkuInput[] {
  return body.skus.map((sku) => ({
    skuId: Number(sku.skuId),
    price: sku.price,
    stock: sku.stock,
    quota: sku.quota ?? null,
    isEnabled: sku.isEnabled,
  }));
}

/** The form's SKUs with the stock each was showing when it loaded. */
function expectedOf(body: PresaleActivityForm, skus: readonly repo.ActivitySkuInput[]) {
  return skus.map((sku, index) => ({ ...sku, expectedStock: body.skus[index]?.expectedStock }));
}

function toListItem(row: repo.ActivityRow): PresaleActivityListItem {
  return {
    id: toId(row.id),
    productId: toId(row.productId),
    productName: row.productName,
    title: row.title,
    intro: row.intro,
    imageUrl: row.imageUrl,
    status: row.status,
    paymentMode: row.paymentMode,
    price: row.price,
    originalPrice: row.originalPrice,
    stock: row.stock,
    sales: row.sales,
    totalQuota: row.totalQuota,
    perOrderQuantity: row.perOrderQuantity,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    shipAfterDays: row.shipAfterDays,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

async function toDetail(
  ctx: Ctx,
  row: repo.ActivityRow,
  tx?: Parameters<typeof repo.listActivitySkus>[0],
): Promise<PresaleActivityDetail> {
  const skus = await repo.listActivitySkus(tx ?? ctx.db, [row.id]);
  return {
    ...toListItem(row),
    sliderImages: row.sliderImages,
    shippingTemplateId: toIdOrNull(row.shippingTemplateId),
    skus: skus.map((sku) => ({
      skuId: toId(sku.skuId),
      specText: sku.specText,
      price: sku.price,
      stock: sku.stock,
      sales: sku.sales,
      quota: sku.quota,
      isEnabled: sku.isEnabled,
    })),
  };
}

function toCard(row: repo.ActivityRow, now: Date): PresaleCard {
  return {
    activityId: toId(row.id),
    productId: toId(row.productId),
    title: row.title,
    intro: row.intro,
    imageUrl: row.imageUrl,
    price: row.price,
    originalPrice: row.originalPrice,
    stock: row.stock,
    sales: row.sales,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    shipAfterDays: row.shipAfterDays,
    // The server's decision, never the client's: the button is disabled by the
    // same rule the `OrderKindHandler` will enforce a moment later.
    canBuy: canBuy(row, now),
  };
}

function pageBounds(query: PageQuery): { offset: number; limit: number } {
  return { offset: (query.page - 1) * query.pageSize, limit: query.pageSize };
}

/** `status=a&status=b` reaches the service as an array; one value as a scalar. */
function asArray<T extends string>(value: T | readonly T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? [...value] : [value as T];
}
