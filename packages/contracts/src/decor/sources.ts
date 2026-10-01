import { z } from 'zod';

import { id, instant, money } from '../_conventions/common';
import { claimableCoupon } from '../coupon/schemas';
import { groupbuyCard } from '../groupbuy/schemas';
import { presaleCard } from '../presale/schemas';
import { DECOR_LIMITS, PRODUCT_SORT, type ProductSort } from './constants';
import { ui } from './meta';

/**
 * Declarative data sources (plan §2.1).
 *
 * A block never fetches. It stores *where* its records come from — a list of
 * ids, or a rule such as "category 12, best-selling, 6 of them" — and the
 * storefront resolver turns that into records on the server, in the same
 * response as the page. The editor shows the same sources through its record
 * pickers (`meta.field` names the picker; see `meta.ts`).
 *
 * Each source is a union on `mode`. `manual` keeps the operator's order and
 * silently skips what the shopper can no longer see (off the shelf, deleted,
 * outside its window); a rule-based mode is re-evaluated on every resolve
 * (within the short public cache).
 */

const sortKeys = Object.keys(PRODUCT_SORT) as [ProductSort, ...ProductSort[]];

const productSort = z
  .enum(sortKeys)
  .default('default')
  .meta(ui({ label: '排序', options: PRODUCT_SORT }));

const autoProductLimit = z
  .number()
  .int()
  .min(1)
  .max(DECOR_LIMITS.autoProducts)
  .default(6)
  .meta(ui({ label: '显示数量' }));

export const productSource = z
  .discriminatedUnion('mode', [
    z.object({
      mode: z.literal('manual'),
      ids: z.array(id).max(DECOR_LIMITS.manualProducts),
    }),
    z.object({
      mode: z.literal('category'),
      categoryId: id,
      sort: productSort,
      limit: autoProductLimit,
    }),
    z.object({
      mode: z.literal('label'),
      labelId: id,
      sort: productSort,
      limit: autoProductLimit,
    }),
  ])
  .meta(ui({ label: '商品来源', field: 'productSource' }));
export type ProductSource = z.infer<typeof productSource>;

const recordLimit = z
  .number()
  .int()
  .min(1)
  .max(DECOR_LIMITS.records)
  .default(3)
  .meta(ui({ label: '显示数量' }));

const manualRecords = z.object({
  mode: z.literal('manual'),
  ids: z.array(id).max(DECOR_LIMITS.records),
});

/**
 * Coupon templates a shopper can claim by hand. `auto`: the first `limit` the
 * shopper could claim now, in the coupon centre's order.
 */
export const couponSource = z
  .discriminatedUnion('mode', [
    manualRecords,
    z.object({ mode: z.literal('auto'), limit: recordLimit }),
  ])
  .meta(ui({ label: '优惠券', field: 'couponSource' }));
export type CouponSource = z.infer<typeof couponSource>;

/** Group-buy campaigns visible now. `auto`: the first `limit` in the 拼团 list's order. */
export const groupbuySource = z
  .discriminatedUnion('mode', [
    manualRecords,
    z.object({ mode: z.literal('auto'), limit: recordLimit }),
  ])
  .meta(ui({ label: '拼团活动', field: 'groupbuySource' }));
export type GroupbuySource = z.infer<typeof groupbuySource>;

/** Presale campaigns visible now. `auto`: the first `limit` in the 预售 list's order. */
export const presaleSource = z
  .discriminatedUnion('mode', [
    manualRecords,
    z.object({ mode: z.literal('auto'), limit: recordLimit }),
  ])
  .meta(ui({ label: '预售活动', field: 'presaleSource' }));
export type PresaleSource = z.infer<typeof presaleSource>;

/** Published articles. `category`: newest first, in one category or (no id) in all. */
export const articleSource = z
  .discriminatedUnion('mode', [
    manualRecords,
    z.object({
      mode: z.literal('category'),
      categoryId: id.optional(),
      limit: recordLimit,
    }),
  ])
  .meta(ui({ label: '资讯', field: 'articleSource' }));
export type ArticleSource = z.infer<typeof articleSource>;

// ---------------------------------------------------------------------------
// what a block asks the resolver for
// ---------------------------------------------------------------------------

/**
 * One piece of data a block needs, as its `defineBlock({ data })` declares it.
 * A block names each need by a slot (`{ products: need.products(props.source) }`)
 * and receives `data[slot]` — the resolved records — beside its props.
 */
export type DataNeed =
  | { kind: 'products'; source: ProductSource }
  | { kind: 'coupons'; source: CouponSource }
  /** The coupons a new account is granted (新人券); never claimable by hand. */
  | { kind: 'newUserCoupons'; limit: number }
  | { kind: 'groupbuys'; source: GroupbuySource }
  | { kind: 'presales'; source: PresaleSource }
  | { kind: 'articles'; source: ArticleSource };

export type DataNeedKind = DataNeed['kind'];

/** Constructors, so a block's `data` reads as a sentence. */
export const need = {
  products: (source: ProductSource): DataNeed => ({ kind: 'products', source }),
  coupons: (source: CouponSource): DataNeed => ({ kind: 'coupons', source }),
  newUserCoupons: (limit: number): DataNeed => ({ kind: 'newUserCoupons', limit }),
  groupbuys: (source: GroupbuySource): DataNeed => ({ kind: 'groupbuys', source }),
  presales: (source: PresaleSource): DataNeed => ({ kind: 'presales', source }),
  articles: (source: ArticleSource): DataNeed => ({ kind: 'articles', source }),
};

// ---------------------------------------------------------------------------
// what the resolver hands back (public, cacheable)
// ---------------------------------------------------------------------------

/**
 * A product as a block receives it. Built from the catalog's product card:
 * on the shelf only; `soldOut` when no SKU has stock (a manual list keeps a
 * sold-out product the operator chose, a rule-based list leaves it out).
 */
export const productSummary = z.object({
  id,
  title: z.string(),
  image: z.string(),
  price: money,
  /** Struck-through reference price, only when above `price`. */
  marketPrice: money.optional(),
  /** Short badge from the product's first visible label, e.g. 新品 / 热卖. */
  tag: z.string().max(8).optional(),
  soldOut: z.boolean().optional(),
});
export type ProductSummary = z.infer<typeof productSummary>;

/** A claimable coupon without the per-shopper fields, which travel in `personal`. */
export const couponSummary = claimableCoupon.omit({ claimedCount: true, canClaim: true });
export type CouponSummary = z.infer<typeof couponSummary>;

export const groupbuySummary = groupbuyCard;
export type GroupbuySummary = z.infer<typeof groupbuySummary>;

export const presaleSummary = presaleCard;
export type PresaleSummary = z.infer<typeof presaleSummary>;

export const articleSummary = z.object({
  id,
  title: z.string(),
  coverImageUrl: z.string().nullable(),
  summary: z.string().nullable(),
  author: z.string().nullable(),
  categoryTitle: z.string().nullable(),
  views: z.number().int().min(0),
  publishedAt: instant.nullable(),
});
export type ArticleSummary = z.infer<typeof articleSummary>;

/** Resolved records by need kind. */
export interface ResolvedByKind {
  products: ProductSummary[];
  coupons: CouponSummary[];
  newUserCoupons: CouponSummary[];
  groupbuys: GroupbuySummary[];
  presales: PresaleSummary[];
  articles: ArticleSummary[];
}

/** One resolved slot, as it appears in `block.data[slot]`. */
export const resolvedSlot = z.union([
  z.array(productSummary),
  z.array(couponSummary),
  z.array(groupbuySummary),
  z.array(presaleSummary),
  z.array(articleSummary),
]);

// ---------------------------------------------------------------------------
// per-shopper state (only with a session, never cached)
// ---------------------------------------------------------------------------

/** How a signed-in shopper stands with one coupon in a block. */
export const couponUserState = z.object({
  templateId: id,
  claimedCount: z.number().int().min(0),
  /** A 新人券 is never claimable by hand: `false` there, and `claimedCount` says whether it was granted. */
  canClaim: z.boolean(),
});
export type CouponUserState = z.infer<typeof couponUserState>;

/**
 * Per-shopper data a block asks for by its props alone — not tied to records
 * the page shows, as coupon state is. A block declares these with
 * `defineBlock({ personal })`; the resolver answers them only with a session,
 * in `personal[blockId][slot]`, and never caches them (DECOR-015).
 *
 * - `orderCounts`: the 订单入口 badges, from `order.counts`.
 * - `userSummary`: the 用户卡片's nickname and avatar, and with `stats` the
 *   优惠券 / 收藏 / 足迹 totals.
 * - `newcomerCoupons`: the 新人券 the shopper still holds unused (at most
 *   `limit`), for the 新人券 block. 新人券 are granted at registration and
 *   never claimed by hand, so this — not the templates' claim state — is what
 *   decides whether a signed-in shopper sees the block.
 */
export type PersonalNeed =
  | { kind: 'orderCounts' }
  | { kind: 'userSummary'; stats: boolean }
  | { kind: 'newcomerCoupons'; limit: number };

export type PersonalNeedKind = PersonalNeed['kind'];

export const personalNeed = {
  orderCounts: (): PersonalNeed => ({ kind: 'orderCounts' }),
  userSummary: (stats: boolean): PersonalNeed => ({ kind: 'userSummary', stats }),
  newcomerCoupons: (limit: number): PersonalNeed => ({ kind: 'newcomerCoupons', limit }),
};

const count = z.number().int().min(0);

/**
 * The 订单入口 badges, by `ORDER_ENTRY_KEYS`. `aftersale` is the orders with a
 * live after-sales; `unreviewed` is `order.counts`' 待评价 (ORDER-010). It stays
 * optional in the schema: a server from before the count sends none, and the
 * entry then shows no badge rather than a wrong one.
 */
export const orderEntryCounts = z.object({
  unpaid: count,
  unshipped: count,
  unreceived: count,
  aftersale: count,
  unreviewed: count.optional(),
});
export type OrderEntryCounts = z.infer<typeof orderEntryCounts>;

/** Who the 用户卡片 greets. */
export const userSummary = z.object({
  nickname: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /**
   * Still the nickname or avatar sign-up gave them: the card asks, once, in
   * small print, to set them. Absent from an older server: no line.
   */
  profileIncomplete: z.boolean().optional(),
  /** Only when the block shows them (`showStats`). */
  stats: z
    .object({
      /** Unused coupons in the wallet. */
      coupons: count,
      favorites: count,
      /** Products in the browsing history window. */
      history: count,
    })
    .nullable(),
});
export type UserSummary = z.infer<typeof userSummary>;

/** A coupon in the shopper's wallet, as the 新人券 block shows it. */
export const heldCoupon = z.object({
  id,
  templateId: id,
  title: z.string(),
  discountAmount: money,
  minSpend: money,
  validTo: instant,
});
export type HeldCoupon = z.infer<typeof heldCoupon>;

/** One slot's per-shopper state, discriminated so a later kind can be added without guessing. */
export const personalSlot = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('coupons'), items: z.array(couponUserState) }),
  z.object({ kind: z.literal('orderCounts'), counts: orderEntryCounts }),
  z.object({ kind: z.literal('userSummary'), user: userSummary }),
  z.object({ kind: z.literal('newcomerCoupons'), coupons: z.array(heldCoupon) }),
]);
export type PersonalSlot = z.infer<typeof personalSlot>;
