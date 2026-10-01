import type { ProductKind, ProductSpecInput } from '@shop/contracts/catalog/schemas';

/**
 * Everything the catalog can decide without the database.
 *
 * Pure functions with a plain unit test (`catalog.rules.test.ts`, no Docker,
 * milliseconds). Keeping the arithmetic and the combinatorics here is what lets
 * the integration test be about *state* — stock races, shelf status, review
 * uniqueness — instead of re-deriving a spec matrix through PostgreSQL.
 */

// ---------------------------------------------------------------------------
// spec matrix
// ---------------------------------------------------------------------------

/** The separator between spec values in `specText` (`红|XL`). Order data quotes it, so it never changes. */
export const SPEC_SEPARATOR = '|';

export interface SkuCombination {
  specValues: Record<string, string>;
  specText: string;
}

/**
 * The Cartesian product of the spec axes, in declaration order.
 *
 * Declaration order is the contract: `specText` is `红|XL`, not `XL|红`, and it
 * is a unique index (`product_skus_spec_uq`), so the same product edited twice
 * must produce the same string for the same combination. Sorting the axes
 * instead would reorder every existing SKU the first time an operator renamed
 * one.
 *
 * The editor and the server both need this matrix, and two builds of it would
 * disagree about empty values. One function, called from both.
 */
export function skuMatrix(specs: readonly ProductSpecInput[]): SkuCombination[] {
  if (specs.length === 0) return [];
  let rows: Record<string, string>[] = [{}];
  for (const spec of specs) {
    const next: Record<string, string>[] = [];
    for (const row of rows) {
      for (const value of spec.values) {
        next.push({ ...row, [spec.name]: value.value });
      }
    }
    rows = next;
  }
  return rows.map((specValues) => ({
    specValues,
    specText: specTextOf(
      specValues,
      specs.map((s) => s.name),
    ),
  }));
}

/**
 * `{ 颜色: '红', 尺码: 'XL' }` + `['颜色','尺码']` -> `红|XL`.
 *
 * An axis missing from `specValues` contributes nothing, which is what makes a
 * single-spec product's `specText` the empty string.
 */
export function specTextOf(
  specValues: Readonly<Record<string, string>>,
  axisOrder: readonly string[],
): string {
  return axisOrder
    .map((axis) => specValues[axis])
    .filter((value): value is string => value !== undefined && value !== '')
    .join(SPEC_SEPARATOR);
}

/**
 * Separators no spec value will contain, written as two-character escapes
 * rather than as literal control bytes: a raw `\x1f` in a source file is
 * invisible in every diff and makes the whole file "binary" to grep.
 */
const AXIS_SEPARATOR = '\\u001f';
const PAIR_SEPARATOR = '\\u001e';

/**
 * Order-independent identity of a spec combination.
 *
 * Used to match an incoming matrix row to the SKU already in the database, so
 * that reordering the axes in the editor re-prices the existing rows instead of
 * deleting every SKU and inserting new ones — which would reset stock and sales
 * and orphan every cart row pointing at the old ids.
 */
export function comboKey(specValues: Readonly<Record<string, string>>): string {
  return Object.keys(specValues)
    .sort()
    .map((axis) => `${axis}${AXIS_SEPARATOR}${specValues[axis]}`)
    .join(PAIR_SEPARATOR);
}

// ---------------------------------------------------------------------------
// product rules
// ---------------------------------------------------------------------------

/**
 * Whether a product may go in a cart.
 *
 * Only a physical product without a custom form, and not on presale, goes in
 * the cart; everything else is bought on its own. `presale` belongs to the
 * presale domain, and it passes its own flag in.
 */
export function canAddToCart(input: {
  kind: ProductKind;
  hasCustomForm: boolean;
  /** The presale domain sets this for a product with a live presale activity. */
  isPresale?: boolean;
}): boolean {
  if (input.kind !== 'physical') return false;
  if (input.hasCustomForm) return false;
  return input.isPresale !== true;
}

/** A virtual product never costs freight, whatever the template says. */
export function chargesFreight(kind: ProductKind): boolean {
  return kind === 'physical';
}

/** The number the storefront shows: real sales plus the operator's padding. */
export function salesDisplay(sales: number, displaySalesBoost: number): number {
  return Math.max(0, sales) + Math.max(0, displaySalesBoost);
}

export type PurchaseLimitMode = 'none' | 'per_order' | 'lifetime';

export interface PurchaseLimitVerdict {
  ok: boolean;
  /** `null` when `ok`. */
  reason: 'below-minimum' | 'limit-reached' | null;
  /** How many more the shopper may still buy; `null` when unlimited. */
  remaining: number | null;
}

/**
 * The 限购 / 起购 check.
 *
 * `alreadyBought` only matters for `lifetime`; a `per_order` limit is decided
 * on the one basket. One function for every caller, so `>= limit` in one place
 * and `> limit` in another cannot let a lifetime limit of 1 allow two.
 */
export function checkPurchaseLimit(input: {
  mode: PurchaseLimitMode;
  limitQuantity: number | null;
  minQuantity: number;
  requested: number;
  /** Units of this product the shopper has already bought, for `lifetime`. */
  alreadyBought: number;
}): PurchaseLimitVerdict {
  if (input.requested < input.minQuantity) {
    return { ok: false, reason: 'below-minimum', remaining: null };
  }
  if (input.mode === 'none' || input.limitQuantity === null) {
    return { ok: true, reason: null, remaining: null };
  }
  const consumed = input.mode === 'lifetime' ? input.alreadyBought : 0;
  const remaining = Math.max(0, input.limitQuantity - consumed);
  if (input.requested > remaining) {
    return { ok: false, reason: 'limit-reached', remaining };
  }
  return { ok: true, reason: null, remaining: remaining - input.requested };
}

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

/** The tree the admin renders and the cascader consumes. A fourth level is refused. */
export const MAX_CATEGORY_DEPTH = 3;

/** The materialised path a child of `parent` gets. A root category's path is `/`. */
export function childPath(parent: { id: number; path: string } | null): string {
  if (parent === null) return '/';
  return `${parent.path}${parent.id}/`;
}

/** Depth from a path: `/` is 0, `/7/` is 1, `/7/17/` is 2. */
export function levelOfPath(path: string): number {
  return path.split('/').filter(Boolean).length;
}

/** The ancestor ids encoded in a path, outermost first. */
export function ancestorIdsOfPath(path: string): number[] {
  return path
    .split('/')
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Whether moving `categoryId` under `newParent` would make a cycle.
 *
 * A category may not become a child of itself or of any of its own
 * descendants. The descendant test is a prefix test on the materialised path,
 * which is why the column exists.
 */
export function wouldCycle(input: {
  categoryId: number;
  categoryPath: string;
  newParent: { id: number; path: string } | null;
}): boolean {
  if (input.newParent === null) return false;
  if (input.newParent.id === input.categoryId) return true;
  const ownSubtreePrefix = `${input.categoryPath}${input.categoryId}/`;
  const parentFullPath = `${input.newParent.path}${input.newParent.id}/`;
  return parentFullPath.startsWith(ownSubtreePrefix);
}

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

export type RatingBucket = 'good' | 'medium' | 'bad';

/** 好评 4–5 / 中评 3 / 差评 1–2, the grouping the console shows. */
export function ratingBucket(productScore: number): RatingBucket {
  if (productScore >= 4) return 'good';
  if (productScore === 3) return 'medium';
  return 'bad';
}

export interface ReviewCounts {
  total: number;
  good: number;
  medium: number;
  bad: number;
  withImages: number;
  /** Sum of `productScore` over the counted reviews. */
  scoreSum: number;
}

export interface ReviewSummaryValues {
  total: number;
  goodCount: number;
  mediumCount: number;
  badCount: number;
  withImagesCount: number;
  averageScore: number;
  goodRate: number;
}

/**
 * The header above the review list.
 *
 * An unreviewed product reports `goodRate = 100`: a new product should not open
 * with "0% positive". `averageScore` is rounded to one decimal because that is
 * all the UI renders, and rounding once here keeps the number the same on every
 * surface.
 */
export function summariseReviews(counts: ReviewCounts): ReviewSummaryValues {
  const total = Math.max(0, counts.total);
  return {
    total,
    goodCount: counts.good,
    mediumCount: counts.medium,
    badCount: counts.bad,
    withImagesCount: counts.withImages,
    averageScore: total === 0 ? 0 : Math.round((counts.scoreSum / total) * 10) / 10,
    goodRate: total === 0 ? 100 : Math.round((counts.good / total) * 100),
  };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * What a keyword becomes before it reaches `ILIKE`/`pg_trgm`.
 *
 * `%` and `_` are escaped so a shopper searching for `100%纯棉` gets the product
 * rather than everything. Collapsing whitespace matters for Chinese input
 * methods, which happily leave a trailing space.
 */
export function normaliseKeyword(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 64);
}

export { containsPattern as likePattern } from '../kernel/like';

// ---------------------------------------------------------------------------
// SKU codes
// ---------------------------------------------------------------------------

const SKU_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A stable, opaque variant key.
 *
 * `product_skus.skuCode` is `varchar(32)` and globally unique; it travels on
 * cart rows and order items, so it must not encode the product id (a code has
 * to survive the product being merged or renumbered) and must not be guessable
 * in sequence. Takes its randomness as an argument so the unit test is
 * deterministic.
 */
export function skuCodeFrom(randomBytes: Uint8Array): string {
  let out = 'SKU';
  for (const byte of randomBytes) out += SKU_ALPHABET[byte % SKU_ALPHABET.length];
  return out.slice(0, 32);
}

// ---------------------------------------------------------------------------
// denormalised product columns
// ---------------------------------------------------------------------------

export interface SkuRollupInput {
  price: string;
  cost: string | null;
  stock: number;
  isVisible: boolean;
}

export interface SkuRollup {
  /** Cheapest visible SKU price, for list sorting and filtering. */
  price: string;
  /** Cheapest visible SKU cost. `null` when no visible SKU records one. */
  cost: string | null;
  /** Sum of visible SKU stock. */
  stock: number;
}

/**
 * The three denormalised columns on `products`, recomputed from the SKUs.
 *
 * Invisible SKUs are excluded from all three: a hidden variant must not set the
 * "from ¥x" price on a card nobody can buy at that price, and it must not make
 * a sold-out product look in stock.
 *
 * Comparison is on the decimal string, parsed to integer 分 by the caller's
 * `Money`; here the strings are compared by length-then-lexicographically,
 * which is exact for the fixed two-decimal format the contract enforces.
 */
export function rollupSkus(skus: readonly SkuRollupInput[]): SkuRollup {
  const visible = skus.filter((s) => s.isVisible);
  const counted = visible.length > 0 ? visible : [];
  if (counted.length === 0) return { price: '0.00', cost: null, stock: 0 };

  let price = counted[0]!.price;
  let cost: string | null = null;
  let stock = 0;
  for (const sku of counted) {
    if (compareDecimal(sku.price, price) < 0) price = sku.price;
    if (sku.cost !== null && (cost === null || compareDecimal(sku.cost, cost) < 0)) cost = sku.cost;
    stock += Math.max(0, sku.stock);
  }
  return { price, cost, stock };
}

/** Exact comparison of two fixed-two-decimal strings, without touching a float. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const [ai = '0', af = ''] = a.split('.');
  const [bi = '0', bf = ''] = b.split('.');
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const af2 = af.padEnd(4, '0');
  const bf2 = bf.padEnd(4, '0');
  if (af2 === bf2) return 0;
  return af2 < bf2 ? -1 : 1;
}
