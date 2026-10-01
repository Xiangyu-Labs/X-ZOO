import type { DbOrTx, Tx } from '@shop/db';
import {
  couponTemplateCategories,
  couponTemplateProducts,
  couponTemplates,
  productGiftCoupons,
  userCoupons,
} from '@shop/db/schema/coupon';
import { productCategoriesMap } from '@shop/db/schema/catalog';
import { users } from '@shop/db/schema/user';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { allOf, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';
import { containsPattern } from '../kernel/like';

/**
 * The only file in the coupon domain that touches Drizzle tables
 * (`docs/conventions.md`, "Import boundaries"; enforced by the `boundaries`
 * ESLint rule, which allows `@shop/db/schema/*` from `*.repo.ts` and
 * `*.test.ts` only).
 *
 * A repo function is a *statement*, not a decision: it returns rows, or the
 * number of rows a conditional update changed. Every branch on that number
 * lives in `coupon.service.ts`. That split is what makes the concurrency tests
 * readable — they call the repo directly and assert on `won`.
 */

// ---------------------------------------------------------------------------
// row shapes
// ---------------------------------------------------------------------------

export type TemplateRow = typeof couponTemplates.$inferSelect;
export type UserCouponRow = typeof userCoupons.$inferSelect;

export interface ScopeLinks {
  productIds: number[];
  categoryIds: number[];
}

const liveTemplate = (): SQL | undefined => isNull(couponTemplates.deletedAt);

// ---------------------------------------------------------------------------
// templates — reads
// ---------------------------------------------------------------------------

export async function findTemplate(db: DbOrTx, id: number): Promise<TemplateRow | null> {
  const rows = await db
    .select()
    .from(couponTemplates)
    .where(and(eq(couponTemplates.id, id), liveTemplate()))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The template, locked for the rest of the transaction. An edit derives the
 * new `remaining_count` from the current one; a claim committing between an
 * unlocked read and the write would be overwritten.
 */
export async function lockTemplate(tx: Tx, id: number): Promise<TemplateRow | null> {
  const rows = await tx
    .select()
    .from(couponTemplates)
    .where(and(eq(couponTemplates.id, id), liveTemplate()))
    .for('update');
  return rows[0] ?? null;
}

/**
 * A template's status whatever its deletion state, or null if there is no such
 * row. A soft-deleted template's wallet coupons are still spendable, and their
 * scope is still read from it (`templateTerms`), so a scope lookup must see it.
 */
export async function templateStatus(
  db: DbOrTx,
  id: number,
): Promise<'draft' | 'active' | 'disabled' | null> {
  const rows = await db
    .select({ status: couponTemplates.status })
    .from(couponTemplates)
    .where(eq(couponTemplates.id, id))
    .limit(1);
  return rows[0]?.status ?? null;
}

export interface TemplateListFilter {
  keyword?: string | undefined;
  status?: readonly ('draft' | 'active' | 'disabled')[] | undefined;
  scope?: 'all_products' | 'categories' | 'products' | undefined;
  claimMode?: 'manual' | 'new_user' | 'order_gift' | 'admin_grant' | undefined;
}

export type TemplateSortKey = 'id' | 'name' | 'discountAmount' | 'sortOrder' | 'createdAt';

const TEMPLATE_SORT = {
  id: couponTemplates.id,
  name: couponTemplates.name,
  discountAmount: couponTemplates.discountAmount,
  sortOrder: couponTemplates.sortOrder,
  createdAt: couponTemplates.createdAt,
} as const;

function templateFilter(filter: TemplateListFilter): SQL | undefined {
  return allOf(
    liveTemplate(),
    filter.keyword
      ? sql`${couponTemplates.name} ilike ${containsPattern(filter.keyword)}`
      : undefined,
    filter.status && filter.status.length > 0
      ? inArray(couponTemplates.status, [...filter.status])
      : undefined,
    filter.scope ? eq(couponTemplates.scope, filter.scope) : undefined,
    filter.claimMode ? eq(couponTemplates.claimMode, filter.claimMode) : undefined,
  );
}

export async function listTemplates(
  db: DbOrTx,
  args: TemplateListFilter & {
    offset: number;
    limit: number;
    sortBy?: TemplateSortKey | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  },
): Promise<{ rows: TemplateRow[]; total: number }> {
  const where = templateFilter(args);
  const column = TEMPLATE_SORT[args.sortBy ?? 'id'];
  const direction = args.sortOrder === 'asc' ? asc : desc;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(couponTemplates)
      .where(where)
      // `id` last so the order is total: two templates with the same `sortOrder`
      // must not swap places between pages.
      .orderBy(direction(column), desc(couponTemplates.id))
      .offset(args.offset)
      .limit(args.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(couponTemplates)
      .where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

/** `template_id -> number of user_coupons issued`, for the admin list. One query, not N. */
export async function issuedCounts(
  db: DbOrTx,
  templateIds: readonly number[],
): Promise<Map<number, number>> {
  if (templateIds.length === 0) return new Map();
  const rows = await db
    .select({ templateId: userCoupons.templateId, total: sql<number>`count(*)::int` })
    .from(userCoupons)
    .where(inArray(userCoupons.templateId, [...templateIds]))
    .groupBy(userCoupons.templateId);
  return new Map(rows.map((r) => [r.templateId, r.total]));
}

export async function scopeLinks(db: DbOrTx, templateId: number): Promise<ScopeLinks> {
  const [products, categories] = await Promise.all([
    db
      .select({ productId: couponTemplateProducts.productId })
      .from(couponTemplateProducts)
      .where(eq(couponTemplateProducts.templateId, templateId))
      .orderBy(asc(couponTemplateProducts.productId)),
    db
      .select({ categoryId: couponTemplateCategories.categoryId })
      .from(couponTemplateCategories)
      .where(eq(couponTemplateCategories.templateId, templateId))
      .orderBy(asc(couponTemplateCategories.categoryId)),
  ]);
  return {
    productIds: products.map((r) => r.productId),
    categoryIds: categories.map((r) => r.categoryId),
  };
}

/** A template's applicability, which a `user_coupons` row does not snapshot. */
export interface TemplateTerms extends ScopeLinks {
  scope: 'all_products' | 'categories' | 'products';
}

/**
 * Applicability for many templates at once, for the wallet and the checkout
 * picker: three statements whatever the page size, never one per coupon.
 *
 * A `user_coupons` row carries the *amounts* as a snapshot but not the scope,
 * which is resolved from the template at read time. So the scope must be looked
 * up, and this is the batched way.
 */
export async function templateTermsFor(
  db: DbOrTx,
  templateIds: readonly number[],
): Promise<Map<number, TemplateTerms>> {
  const out = new Map<number, TemplateTerms>();
  if (templateIds.length === 0) return out;
  const ids = [...new Set(templateIds)];
  const [scopes, products, categories] = await Promise.all([
    db
      .select({ id: couponTemplates.id, scope: couponTemplates.scope })
      .from(couponTemplates)
      .where(inArray(couponTemplates.id, ids)),
    db
      .select({
        templateId: couponTemplateProducts.templateId,
        productId: couponTemplateProducts.productId,
      })
      .from(couponTemplateProducts)
      .where(inArray(couponTemplateProducts.templateId, ids)),
    db
      .select({
        templateId: couponTemplateCategories.templateId,
        categoryId: couponTemplateCategories.categoryId,
      })
      .from(couponTemplateCategories)
      .where(inArray(couponTemplateCategories.templateId, ids)),
  ]);
  const get = (id: number): TemplateTerms => {
    let entry = out.get(id);
    if (!entry) {
      entry = { scope: 'all_products', productIds: [], categoryIds: [] };
      out.set(id, entry);
    }
    return entry;
  };
  for (const row of scopes) get(row.id).scope = row.scope;
  for (const row of products) get(row.templateId).productIds.push(row.productId);
  for (const row of categories) get(row.templateId).categoryIds.push(row.categoryId);
  return out;
}

/** `templateTermsFor` for one id. */
export async function templateTerms(db: DbOrTx, templateId: number): Promise<TemplateTerms> {
  const terms = await templateTermsFor(db, [templateId]);
  return terms.get(templateId) ?? { scope: 'all_products', productIds: [], categoryIds: [] };
}

/**
 * `product_id -> category ids`, batched, for the checkout picker — the server
 * decides which categories a line is in, never the request body.
 *
 * The same table, and the same rows, the catalog's `CatalogPort` hands the
 * checkout (`catalog.sale.ts`): the picker and the order must agree on which
 * lines a 品类券 covers. Read here rather than through `@shop/core/catalog`
 * because catalog → order → coupon already import each other in that
 * direction, and a coupon → catalog import would close the cycle. This is a
 * read of the link table only, as `groupbuy.repo.ts` and `presale.repo.ts`
 * read `products`; nothing in this domain writes a catalog table.
 */
export async function productCategoryIds(
  db: DbOrTx,
  productIds: readonly number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  const unique = [...new Set(productIds)];
  if (unique.length === 0) return out;
  const rows = await db
    .select({
      productId: productCategoriesMap.productId,
      categoryId: productCategoriesMap.categoryId,
    })
    .from(productCategoriesMap)
    .where(inArray(productCategoriesMap.productId, unique))
    .orderBy(asc(productCategoriesMap.categoryId));
  for (const row of rows) {
    const list = out.get(row.productId) ?? [];
    list.push(row.categoryId);
    out.set(row.productId, list);
  }
  return out;
}

/**
 * The template's scope covers `productId` — `eligibleLineIndexes` (coupon.rules.ts)
 * as SQL, over the same rows the checkout reads: `all_products`; `products`
 * naming it; or `categories` sharing a category with its direct
 * `product_categories_map` rows (what `productCategoryIds` and the catalog's
 * `categoryIdsFor` hand the checkout). The two must agree, or a coupon offered on
 * a product page would be refused at checkout.
 */
function coversProduct(productId: number): SQL {
  return sql`(
    ${couponTemplates.scope} = 'all_products'
    or (${couponTemplates.scope} = 'products' and exists (
      select 1 from ${couponTemplateProducts}
      where ${couponTemplateProducts.templateId} = ${couponTemplates.id}
        and ${couponTemplateProducts.productId} = ${productId}))
    or (${couponTemplates.scope} = 'categories' and exists (
      select 1 from ${couponTemplateCategories}
      join ${productCategoriesMap}
        on ${productCategoriesMap.categoryId} = ${couponTemplateCategories.categoryId}
      where ${couponTemplateCategories.templateId} = ${couponTemplates.id}
        and ${productCategoriesMap.productId} = ${productId}))
  )`;
}

/**
 * Templates a shopper may claim by hand right now, ignoring their own limit.
 * With `ids`, only those templates, in that order.
 */
export async function listClaimable(
  db: DbOrTx,
  args: {
    now: Date;
    ids?: readonly number[] | undefined;
    productId?: number | undefined;
    offset: number;
    limit: number;
  },
): Promise<{ rows: TemplateRow[]; total: number }> {
  const where = and(
    liveTemplate(),
    args.ids === undefined ? undefined : inArray(couponTemplates.id, [...args.ids]),
    args.productId === undefined ? undefined : coversProduct(args.productId),
    eq(couponTemplates.status, 'active'),
    eq(couponTemplates.claimMode, 'manual'),
    or(isNull(couponTemplates.claimFrom), lte(couponTemplates.claimFrom, args.now)),
    or(isNull(couponTemplates.claimTo), gte(couponTemplates.claimTo, args.now)),
    or(eq(couponTemplates.isUnlimitedSupply, true), gt(couponTemplates.remainingCount, 0)),
    // A fixed window that has already closed would issue a dead coupon.
    or(isNull(couponTemplates.validTo), gte(couponTemplates.validTo, args.now)),
  );
  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(couponTemplates)
      .where(where)
      .orderBy(
        ...(args.ids === undefined
          ? [desc(couponTemplates.sortOrder), desc(couponTemplates.id)]
          : [sql`array_position(${sql.param([...args.ids])}::bigint[], ${couponTemplates.id})`]),
      )
      .offset(args.offset)
      .limit(args.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(couponTemplates)
      .where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

/** Active templates of one issue mode, for the new-user and order-gift grants. */
export async function listIssuableByMode(
  db: DbOrTx,
  args: { mode: 'new_user' | 'order_gift'; now: Date },
): Promise<TemplateRow[]> {
  return db
    .select()
    .from(couponTemplates)
    .where(
      and(
        liveTemplate(),
        eq(couponTemplates.status, 'active'),
        eq(couponTemplates.claimMode, args.mode),
        or(isNull(couponTemplates.claimFrom), lte(couponTemplates.claimFrom, args.now)),
        or(isNull(couponTemplates.claimTo), gte(couponTemplates.claimTo, args.now)),
        or(eq(couponTemplates.isUnlimitedSupply, true), gt(couponTemplates.remainingCount, 0)),
        or(isNull(couponTemplates.validTo), gte(couponTemplates.validTo, args.now)),
      ),
    )
    .orderBy(asc(couponTemplates.id));
}

/**
 * "Buy this product, get this coupon" — the templates linked to any of `productIds`.
 *
 * Two statements rather than a `DISTINCT ON` join: the link table is tiny, and
 * a join here would hand back a row shape keyed by table name that every caller
 * would then have to unwrap.
 */
export async function listProductGiftTemplates(
  db: DbOrTx,
  args: { productIds: readonly number[]; now: Date },
): Promise<TemplateRow[]> {
  if (args.productIds.length === 0) return [];
  const links = await db
    .selectDistinct({ templateId: productGiftCoupons.templateId })
    .from(productGiftCoupons)
    .where(inArray(productGiftCoupons.productId, [...args.productIds]));
  if (links.length === 0) return [];
  return db
    .select()
    .from(couponTemplates)
    .where(
      and(
        inArray(
          couponTemplates.id,
          links.map((l) => l.templateId),
        ),
        liveTemplate(),
        eq(couponTemplates.status, 'active'),
        or(eq(couponTemplates.isUnlimitedSupply, true), gt(couponTemplates.remainingCount, 0)),
        or(isNull(couponTemplates.validTo), gte(couponTemplates.validTo, args.now)),
      ),
    )
    .orderBy(asc(couponTemplates.id));
}

// ---------------------------------------------------------------------------
// templates — writes
// ---------------------------------------------------------------------------

export type NewTemplateValues = typeof couponTemplates.$inferInsert;

export async function insertTemplate(tx: Tx, values: NewTemplateValues): Promise<TemplateRow> {
  const rows = await tx.insert(couponTemplates).values(values).returning();
  return rows[0]!;
}

export async function updateTemplate(
  tx: Tx,
  id: number,
  values: Partial<NewTemplateValues>,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, couponTemplates, {
    where: and(eq(couponTemplates.id, id), liveTemplate()),
    set: values,
  });
}

/**
 * Flips `status`, guarded on the value it is moving *from*, so two operators
 * clicking the switch at once cannot both report success.
 */
export async function setTemplateStatus(
  tx: Tx,
  args: {
    id: number;
    from: readonly ('draft' | 'active' | 'disabled')[];
    to: 'active' | 'disabled';
    now: Date;
  },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, couponTemplates, {
    where: and(
      eq(couponTemplates.id, args.id),
      inArray(couponTemplates.status, [...args.from]),
      liveTemplate(),
    ),
    set: { status: args.to, updatedAt: args.now },
  });
}

export async function softDeleteTemplate(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, couponTemplates, {
    where: and(eq(couponTemplates.id, args.id), liveTemplate()),
    set: { deletedAt: args.now, updatedAt: args.now },
  });
}

/** Replaces the scope lists wholesale. Cheaper to reason about than a diff, and the rows are tiny. */
export async function replaceScopeLinks(
  tx: Tx,
  templateId: number,
  links: { productIds: readonly number[]; categoryIds: readonly number[] },
): Promise<void> {
  await tx.delete(couponTemplateProducts).where(eq(couponTemplateProducts.templateId, templateId));
  await tx
    .delete(couponTemplateCategories)
    .where(eq(couponTemplateCategories.templateId, templateId));
  if (links.productIds.length > 0) {
    await tx
      .insert(couponTemplateProducts)
      .values([...new Set(links.productIds)].map((productId) => ({ templateId, productId })));
  }
  if (links.categoryIds.length > 0) {
    await tx
      .insert(couponTemplateCategories)
      .values([...new Set(links.categoryIds)].map((categoryId) => ({ templateId, categoryId })));
  }
}

/**
 * **The** conditional update of this domain: take one from the supply.
 *
 * `remaining_count > 0` in the WHERE clause is what makes overselling
 * impossible; `coupon_templates_counts_non_negative` is the backstop that turns
 * a future mistake into a constraint violation instead of a negative counter.
 * An unlimited template has no counter, so it is excluded and the caller skips
 * this call entirely.
 *
 * Read-check-write (`SELECT remain_count` … `if (remain > 0)` … `UPDATE`) would
 * need a lock around it. This is one statement and needs none.
 */
export async function takeOneFromSupply(
  tx: Tx,
  args: { templateId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, couponTemplates, {
    where: and(
      eq(couponTemplates.id, args.templateId),
      eq(couponTemplates.isUnlimitedSupply, false),
      gt(couponTemplates.remainingCount, 0),
      liveTemplate(),
    ),
    set: {
      remainingCount: sql`${couponTemplates.remainingCount} - 1`,
      updatedAt: args.now,
    },
  });
}

/** Disables templates whose claim window closed. Batched, so one pass cannot lock the table. */
export async function disableClosedTemplates(
  tx: Tx,
  args: { now: Date; limit: number },
): Promise<number> {
  const due = await tx
    .select({ id: couponTemplates.id })
    .from(couponTemplates)
    .where(
      and(
        eq(couponTemplates.status, 'active'),
        liveTemplate(),
        lt(couponTemplates.claimTo, args.now),
      ),
    )
    .orderBy(asc(couponTemplates.id))
    .limit(args.limit);
  if (due.length === 0) return 0;
  const { affected } = await conditionalUpdate(tx, couponTemplates, {
    where: and(
      inArray(
        couponTemplates.id,
        due.map((r) => r.id),
      ),
      eq(couponTemplates.status, 'active'),
    ),
    set: { status: 'disabled', updatedAt: args.now },
  });
  return affected;
}

// ---------------------------------------------------------------------------
// user coupons
// ---------------------------------------------------------------------------

export type NewUserCouponValues = typeof userCoupons.$inferInsert;

/**
 * Where this user stands with this template: the `claim_slot` their next
 * coupon would take, and how many they hold that count against the per-user
 * limit.
 *
 * The two differ once a coupon is revoked. A revoked coupon (作废, a refund
 * taking back an order's gift) gives its place under the limit back — that is
 * what makes revoking the inverse of issuing — but keeps its slot, so the next
 * one takes the slot after the highest ever used.
 *
 * Two concurrent issues read the same `nextSlot` — deliberately. The insert
 * that follows is guarded by `user_coupons_slot_uq (template_id, user_id,
 * claim_slot)`, so exactly one of them lands and the loser gets nothing back
 * from `insertUserCoupon`. That is the whole per-user-limit mechanism; there is
 * no lock and no read-then-write window to lose. See SCHEMA.md §3.2.
 */
export async function claimState(
  db: DbOrTx,
  args: { templateId: number; userId: number },
): Promise<{ nextSlot: number; held: number }> {
  const rows = await db
    .select({
      lastSlot: sql<number>`coalesce(max(${userCoupons.claimSlot}), 0)::int`,
      held: sql<number>`(count(*) filter (where ${userCoupons.status} <> 'revoked'))::int`,
    })
    .from(userCoupons)
    .where(and(eq(userCoupons.templateId, args.templateId), eq(userCoupons.userId, args.userId)));
  return { nextSlot: (rows[0]?.lastSlot ?? 0) + 1, held: rows[0]?.held ?? 0 };
}

/**
 * How many coupons this user holds from each of these templates, in one query.
 * Revoked ones do not count, as they do not under the limit (`claimState`).
 * For the storefront lists, which used to ask once per template.
 */
export async function claimedCounts(
  db: DbOrTx,
  args: { templateIds: readonly number[]; userId: number },
): Promise<Map<number, number>> {
  if (args.templateIds.length === 0) return new Map();
  const rows = await db
    .select({ templateId: userCoupons.templateId, total: sql<number>`count(*)::int` })
    .from(userCoupons)
    .where(
      and(
        eq(userCoupons.userId, args.userId),
        inArray(userCoupons.templateId, [...args.templateIds]),
        ne(userCoupons.status, 'revoked'),
      ),
    )
    .groupBy(userCoupons.templateId);
  return new Map(rows.map((row) => [row.templateId, row.total]));
}

/** How many coupons each of these users holds from this template. For the admin grant screen. */
export async function heldCounts(
  db: DbOrTx,
  args: { templateId: number; userIds: readonly number[] },
): Promise<Map<number, number>> {
  if (args.userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: userCoupons.userId, total: sql<number>`count(*)::int` })
    .from(userCoupons)
    .where(
      and(
        eq(userCoupons.templateId, args.templateId),
        inArray(userCoupons.userId, [...args.userIds]),
        ne(userCoupons.status, 'revoked'),
      ),
    )
    .groupBy(userCoupons.userId);
  return new Map(rows.map((r) => [r.userId, r.total]));
}

/**
 * Inserts the wallet row, or returns `null` when a unique index refused it.
 *
 * `ON CONFLICT DO NOTHING` covers both indexes deliberately:
 *  - `user_coupons_slot_uq` — a second concurrent claim by the same user;
 *  - `user_coupons_order_gift_uq` — the same order's gift issued twice, which
 *    is what lets the post-payment handler be retried freely.
 *
 * A `null` here is an expected outcome, not an exception: the service turns it
 * into `COUPON_PER_USER_LIMIT_REACHED` (a 409), never a 500.
 */
export async function insertUserCoupon(
  tx: Tx,
  values: NewUserCouponValues,
): Promise<UserCouponRow | null> {
  const rows = await tx.insert(userCoupons).values(values).onConflictDoNothing().returning();
  return rows[0] ?? null;
}

/**
 * Undo an insert made moments ago in the same transaction, when the supply
 * turned out to be exhausted. Not a user-facing delete: a `user_coupons` row is
 * never removed once it is somebody's to spend — revoking sets `status`.
 */
export async function deleteUserCoupon(tx: Tx, id: number): Promise<void> {
  await tx.delete(userCoupons).where(eq(userCoupons.id, id));
}

export async function findUserCoupon(db: DbOrTx, id: number): Promise<UserCouponRow | null> {
  const rows = await db.select().from(userCoupons).where(eq(userCoupons.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Spend the coupon. One conditional update carrying every precondition:
 * the owner, the state and both ends of the validity window.
 *
 * Zero affected rows is the *only* correct way to learn that a coupon was
 * already spent — a prior `SELECT … status = 'unused'` proves nothing about
 * the instant of the UPDATE. COUPON-004/005/006 all hang off this statement.
 */
export async function redeemUserCoupon(
  tx: Tx,
  args: { id: number; userId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, userCoupons, {
    where: and(
      eq(userCoupons.id, args.id),
      eq(userCoupons.userId, args.userId),
      eq(userCoupons.status, 'unused'),
      lte(userCoupons.validFrom, args.now),
      gte(userCoupons.validTo, args.now),
    ),
    set: { status: 'used', usedAt: args.now, updatedAt: args.now },
  });
}

/**
 * Hand the coupon back on cancel or refund.
 *
 * The CASE keeps it one statement: a coupon whose window has passed while it
 * sat on the order comes back `expired`, not `unused`. Handing it back as
 * 未使用 regardless would leave a customer holding a coupon the checkout then
 * refuses.
 */
export async function releaseUserCoupon(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, userCoupons, {
    where: and(eq(userCoupons.id, args.id), eq(userCoupons.status, 'used')),
    set: {
      // The cast is required: a bare CASE over string literals resolves to
      // `text`, and PostgreSQL has no assignment cast from text to an enum.
      status: sql`(case when ${userCoupons.validTo} >= ${args.now} then 'unused' else 'expired' end)::user_coupons_status`,
      usedAt: null,
      updatedAt: args.now,
    },
  });
}

/**
 * Takes back the unused gift coupons an order earned, and returns each one's
 * unit to its template's supply — the inverse of `insertUserCoupon` +
 * `takeOneFromSupply` for a `gift_order` grant. One conditional `UPDATE`
 * decides which rows are this call's to revoke, so a replay revokes nothing
 * and returns nothing twice. A spent gift is left alone; so is one whose
 * template has since been deleted or whose supply is already full.
 */
export async function revokeOrderGiftCoupons(
  tx: Tx,
  args: { orderId: number; now: Date },
): Promise<number> {
  const revoked = await tx
    .update(userCoupons)
    .set({ status: 'revoked', updatedAt: args.now })
    .where(
      and(
        eq(userCoupons.sourceKind, 'gift_order'),
        eq(userCoupons.sourceOrderId, args.orderId),
        eq(userCoupons.status, 'unused'),
      ),
    )
    .returning({ templateId: userCoupons.templateId });
  for (const row of revoked)
    await returnOneToSupply(tx, { templateId: row.templateId, now: args.now });
  return revoked.length;
}

/**
 * 作废 one coupon the console handed out: the inverse of an `admin_grant`
 * issue. Only an unused one, decided by the same conditional `UPDATE` that
 * revokes it, so a second call — or one racing a checkout that just spent it
 * — revokes nothing and returns nothing to the supply. Returns how many rows it
 * revoked, `0` or `1`.
 */
export async function revokeGrantedCoupon(tx: Tx, args: { id: number; now: Date }): Promise<0 | 1> {
  const revoked = await tx
    .update(userCoupons)
    .set({ status: 'revoked', updatedAt: args.now })
    .where(
      and(
        eq(userCoupons.id, args.id),
        eq(userCoupons.sourceKind, 'admin_grant'),
        eq(userCoupons.status, 'unused'),
      ),
    )
    .returning({ templateId: userCoupons.templateId });
  const row = revoked[0];
  if (!row) return 0;
  await returnOneToSupply(tx, { templateId: row.templateId, now: args.now });
  return 1;
}

/**
 * Give one unit back to a template's supply, the inverse of
 * `takeOneFromSupply`. Guarded, never a written-back count: an unlimited
 * template has no counter, and a full supply (a template since re-stocked by an
 * edit) is left full.
 */
async function returnOneToSupply(tx: Tx, args: { templateId: number; now: Date }): Promise<void> {
  await conditionalUpdate(tx, couponTemplates, {
    where: and(
      eq(couponTemplates.id, args.templateId),
      eq(couponTemplates.isUnlimitedSupply, false),
      sql`${couponTemplates.remainingCount} < ${couponTemplates.totalCount}`,
    ),
    set: {
      remainingCount: sql`${couponTemplates.remainingCount} + 1`,
      updatedAt: args.now,
    },
  });
}

/** The sweep the repeatable job runs. Batched by id so a big backlog drains over several passes. */
export async function expireOverdue(tx: Tx, args: { now: Date; limit: number }): Promise<number> {
  const due = await tx
    .select({ id: userCoupons.id })
    .from(userCoupons)
    .where(and(eq(userCoupons.status, 'unused'), lt(userCoupons.validTo, args.now)))
    .orderBy(asc(userCoupons.id))
    .limit(args.limit);
  if (due.length === 0) return 0;
  const { affected } = await conditionalUpdate(tx, userCoupons, {
    where: and(
      inArray(
        userCoupons.id,
        due.map((r) => r.id),
      ),
      eq(userCoupons.status, 'unused'),
    ),
    set: { status: 'expired', updatedAt: args.now },
  });
  return affected;
}

export type WalletState = 'unused' | 'used' | 'expired';

/**
 * Which wallet tab a row belongs to. One definition, so every reader agrees on
 * what "unused" means.
 */
function walletStateFilter(state: WalletState, now: Date): SQL | undefined {
  return state === 'unused'
    ? and(eq(userCoupons.status, 'unused'), gte(userCoupons.validTo, now))
    : state === 'used'
      ? eq(userCoupons.status, 'used')
      : or(
          inArray(userCoupons.status, ['expired', 'revoked']),
          // Still `unused` in the table but past its window: the sweep has not
          // reached it yet. The wallet must not show it as spendable.
          and(eq(userCoupons.status, 'unused'), lt(userCoupons.validTo, now)),
        );
}

/** The shopper's wallet. `expired` folds in `revoked`: the customer does not need that distinction. */
export async function listUserCoupons(
  db: DbOrTx,
  args: {
    userId: number;
    state: WalletState;
    now: Date;
    offset: number;
    limit: number;
  },
): Promise<{ rows: UserCouponRow[]; total: number }> {
  const stateFilter = walletStateFilter(args.state, args.now);
  const where = and(eq(userCoupons.userId, args.userId), stateFilter);

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(userCoupons)
      .where(where)
      .orderBy(desc(userCoupons.id))
      .offset(args.offset)
      .limit(args.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(userCoupons)
      .where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

/**
 * The unused, unexpired coupons of one source kind a user holds, soonest to
 * expire first. Read-only; the DIY 新人券 block asks it for `gift_new_user`
 * to tell a shopper their 新人券 are waiting.
 */
export async function listUnusedBySource(
  db: DbOrTx,
  args: {
    userId: number;
    sourceKind: UserCouponRow['sourceKind'];
    now: Date;
    limit: number;
  },
): Promise<UserCouponRow[]> {
  return db
    .select()
    .from(userCoupons)
    .where(
      and(
        eq(userCoupons.userId, args.userId),
        eq(userCoupons.sourceKind, args.sourceKind),
        walletStateFilter('unused', args.now),
      ),
    )
    .orderBy(asc(userCoupons.validTo), asc(userCoupons.id))
    .limit(args.limit);
}

/**
 * The coupons one order earned, oldest first.
 *
 * Filtered on the user as well as the order. The caller has already proved the
 * order belongs to this shopper, so the extra predicate is not what makes the
 * route safe — it is what makes a future caller that forgets to check return
 * nothing instead of somebody else's wallet.
 *
 * `sourceKind` is not filtered: `source_order_id` is only ever set by
 * `gift_order` (`user_coupons_gift_order_present` makes that a CHECK), so
 * naming the kind here would be a second spelling of the same fact.
 */
export async function listOrderGiftCoupons(
  db: DbOrTx,
  args: { orderId: number; userId: number },
): Promise<UserCouponRow[]> {
  return db
    .select()
    .from(userCoupons)
    .where(and(eq(userCoupons.sourceOrderId, args.orderId), eq(userCoupons.userId, args.userId)))
    .orderBy(asc(userCoupons.id));
}

/** Every coupon this user could conceivably spend right now, newest first. Feeds the checkout picker. */
export async function listSpendableUserCoupons(
  db: DbOrTx,
  args: { userId: number; now: Date; limit: number },
): Promise<UserCouponRow[]> {
  return db
    .select()
    .from(userCoupons)
    .where(
      and(
        eq(userCoupons.userId, args.userId),
        eq(userCoupons.status, 'unused'),
        lte(userCoupons.validFrom, args.now),
        gte(userCoupons.validTo, args.now),
      ),
    )
    .orderBy(desc(userCoupons.discountAmount), asc(userCoupons.validTo))
    .limit(args.limit);
}

export interface AdminUserCouponRow extends UserCouponRow {
  userNickname: string | null;
}

export async function adminListUserCoupons(
  db: DbOrTx,
  args: {
    templateId?: number | undefined;
    userId?: number | undefined;
    status?: readonly ('unused' | 'used' | 'expired' | 'revoked')[] | undefined;
    offset: number;
    limit: number;
    sortBy?: 'id' | 'createdAt' | 'validTo' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  },
): Promise<{ rows: AdminUserCouponRow[]; total: number }> {
  const where = allOf(
    args.templateId ? eq(userCoupons.templateId, args.templateId) : undefined,
    args.userId ? eq(userCoupons.userId, args.userId) : undefined,
    args.status && args.status.length > 0
      ? inArray(userCoupons.status, [...args.status])
      : undefined,
  );
  const sortColumn = {
    id: userCoupons.id,
    createdAt: userCoupons.createdAt,
    validTo: userCoupons.validTo,
  }[args.sortBy ?? 'id'];
  const direction = args.sortOrder === 'asc' ? asc : desc;

  const [rows, counted] = await Promise.all([
    db
      .select({ coupon: userCoupons, userNickname: users.nickname })
      .from(userCoupons)
      .innerJoin(users, eq(users.id, userCoupons.userId))
      .where(where)
      .orderBy(direction(sortColumn), desc(userCoupons.id))
      .offset(args.offset)
      .limit(args.limit)
      .then((joined) => joined.map((r) => ({ ...r.coupon, userNickname: r.userNickname }))),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(userCoupons)
      .where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

/** Which of these user ids exist. The admin grant screen refuses the whole call if any is unknown. */
export async function existingUserIds(
  db: DbOrTx,
  userIds: readonly number[],
): Promise<Set<number>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...userIds]), isNull(users.deletedAt)));
  return new Set(rows.map((r) => r.id));
}
