import type { DbOrTx, Tx } from '@shop/db';
import { productDescriptions, products, productSkus } from '@shop/db/schema/catalog';
import {
  groupbuyActivities,
  groupbuyActivitySkus,
  groupbuyGroups,
  groupbuyMembers,
  type GroupbuyActivity,
  type GroupbuyGroup,
  type GroupbuyMember,
} from '@shop/db/schema/groupbuy';
import { orderItems, orders } from '@shop/db/schema/order';
import { users } from '@shop/db/schema/user';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';
import { containsPattern } from '../kernel/like';

/**
 * Every statement the group-buy domain runs. Statements, not decisions: no
 * `DomainError`, no `ctx`, no policy. A repo function returns rows or the
 * number of rows a conditional update changed; every branch on that number
 * lives in the service.
 *
 * Only this file and the tests import `@shop/db/schema/*` (the `boundaries`
 * ESLint rule enforces it). It *reads* `products`, `product_skus`, `orders` and
 * `users` for the display joins the admin and storefront lists need, and
 * *writes* nothing outside the four `groupbuy_*` tables: the SKU stock ledger
 * is the catalog's `StockPort` and the order belongs to the order domain.
 *
 * The statements worth reading are `takeSeat`, `freeSeat` and
 * `reserveActivityStock`. Each carries every precondition in its `WHERE`, so
 * `affected === 0` is the only way a caller learns "somebody was faster".
 */

export type { GroupbuyActivity, GroupbuyGroup, GroupbuyMember };

export type ActivityStatus = 'draft' | 'active' | 'paused' | 'ended';
export type GroupStatus = 'forming' | 'succeeded' | 'failed' | 'cancelled';
export type MemberStatus = 'joined' | 'refunded' | 'cancelled';

/** An order whose money has arrived and whose goods are still owed. */
const PAID_ORDER_STATUSES = ['paid', 'shipped', 'received', 'completed'] as const;

// ---------------------------------------------------------------------------
// activities
// ---------------------------------------------------------------------------

export interface ActivityRow extends GroupbuyActivity {
  productName: string;
}

export interface ActivityListFilters {
  keyword?: string | undefined;
  statuses?: readonly ActivityStatus[] | undefined;
  productId?: number | undefined;
  /** A storefront list shows only what a shopper may see, at this instant. */
  visibleAt?: Date | undefined;
  /** Only these activities (a DIY block's manual pick). Additive: omitted means no id filter. */
  ids?: readonly number[] | undefined;
  sortBy?: string | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  limit: number;
  offset: number;
}

const activitySort = {
  id: groupbuyActivities.id,
  sortOrder: groupbuyActivities.sortOrder,
  sales: groupbuyActivities.sales,
  views: groupbuyActivities.views,
  startAt: groupbuyActivities.startAt,
  createdAt: groupbuyActivities.createdAt,
} as const;

function activityWhere(filters: ActivityListFilters): SQL | undefined {
  const parts: (SQL | undefined)[] = [isNull(groupbuyActivities.deletedAt)];
  if (filters.keyword) {
    parts.push(sql`${groupbuyActivities.title} ilike ${containsPattern(filters.keyword)}`);
  }
  if (filters.statuses && filters.statuses.length > 0) {
    parts.push(inArray(groupbuyActivities.status, [...filters.statuses]));
  }
  if (filters.productId !== undefined) {
    parts.push(eq(groupbuyActivities.productId, filters.productId));
  }
  if (filters.ids !== undefined) {
    parts.push(inArray(groupbuyActivities.id, [...filters.ids]));
  }
  if (filters.visibleAt) {
    parts.push(eq(groupbuyActivities.status, 'active'));
    parts.push(lte(groupbuyActivities.startAt, filters.visibleAt));
    parts.push(gt(groupbuyActivities.endAt, filters.visibleAt));
  }
  return and(...parts);
}

export async function listActivities(
  db: DbOrTx,
  filters: ActivityListFilters,
): Promise<{ rows: ActivityRow[]; total: number }> {
  const where = activityWhere(filters);
  const column =
    activitySort[filters.sortBy as keyof typeof activitySort] ?? activitySort.sortOrder;
  const direction = filters.sortOrder === 'asc' ? asc : desc;

  const rows = await db
    .select({ activity: groupbuyActivities, productName: products.name })
    .from(groupbuyActivities)
    .innerJoin(products, eq(products.id, groupbuyActivities.productId))
    .where(where)
    .orderBy(direction(column), desc(groupbuyActivities.id))
    .limit(filters.limit)
    .offset(filters.offset);

  const [totalRow] = await db.select({ value: count() }).from(groupbuyActivities).where(where);

  return {
    rows: rows.map((row) => ({ ...row.activity, productName: row.productName })),
    total: totalRow?.value ?? 0,
  };
}

export async function findActivity(db: DbOrTx, id: number): Promise<ActivityRow | null> {
  const [row] = await db
    .select({ activity: groupbuyActivities, productName: products.name })
    .from(groupbuyActivities)
    .innerJoin(products, eq(products.id, groupbuyActivities.productId))
    .where(and(eq(groupbuyActivities.id, id), isNull(groupbuyActivities.deletedAt)))
    .limit(1);
  return row ? { ...row.activity, productName: row.productName } : null;
}

export async function insertActivity(
  tx: Tx,
  values: typeof groupbuyActivities.$inferInsert,
): Promise<GroupbuyActivity> {
  const rows = await tx.insert(groupbuyActivities).values(values).returning();
  return rows[0]!;
}

export async function updateActivity(
  tx: Tx,
  id: number,
  values: Partial<typeof groupbuyActivities.$inferInsert>,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyActivities, {
    where: and(eq(groupbuyActivities.id, id), isNull(groupbuyActivities.deletedAt)),
    set: values,
  });
}

/**
 * Status moves carry the status we believe we are leaving, so two operators
 * clicking 上架 and 结束 at the same moment cannot both win.
 */
export async function setActivityStatus(
  tx: Tx,
  args: { id: number; from: readonly ActivityStatus[]; to: ActivityStatus; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyActivities, {
    where: and(
      eq(groupbuyActivities.id, args.id),
      isNull(groupbuyActivities.deletedAt),
      inArray(groupbuyActivities.status, [...args.from]),
    ),
    set: { status: args.to, updatedAt: args.now },
  });
}

/** `active` campaigns whose window has passed, oldest end first — the close sweep's work. */
export async function findClosableActivityIds(
  db: DbOrTx,
  args: { now: Date; limit: number },
): Promise<number[]> {
  const rows = await db
    .select({ id: groupbuyActivities.id })
    .from(groupbuyActivities)
    .where(
      and(
        eq(groupbuyActivities.status, 'active'),
        isNull(groupbuyActivities.deletedAt),
        lte(groupbuyActivities.endAt, args.now),
      ),
    )
    .orderBy(asc(groupbuyActivities.endAt))
    .limit(args.limit);
  return rows.map((row) => row.id);
}

/** `active -> ended` once `end_at` has passed; conditional, so two sweeps converge. */
export async function closeActivity(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyActivities, {
    where: and(
      eq(groupbuyActivities.id, args.id),
      eq(groupbuyActivities.status, 'active'),
      lte(groupbuyActivities.endAt, args.now),
    ),
    set: { status: 'ended', updatedAt: args.now },
  });
}

export async function softDeleteActivity(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyActivities, {
    where: and(eq(groupbuyActivities.id, args.id), isNull(groupbuyActivities.deletedAt)),
    set: { deletedAt: args.now, status: 'ended', updatedAt: args.now },
  });
}

/** The delete guard: a team still forming pins the activity. */
export async function countFormingGroups(db: DbOrTx, activityId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(groupbuyGroups)
    .where(and(eq(groupbuyGroups.activityId, activityId), eq(groupbuyGroups.status, 'forming')));
  return row?.value ?? 0;
}

export async function countFormingGroupsByActivity(
  db: DbOrTx,
  activityIds: readonly number[],
): Promise<Map<number, number>> {
  if (activityIds.length === 0) return new Map();
  const rows = await db
    .select({ activityId: groupbuyGroups.activityId, value: count() })
    .from(groupbuyGroups)
    .where(
      and(
        inArray(groupbuyGroups.activityId, [...activityIds]),
        eq(groupbuyGroups.status, 'forming'),
      ),
    )
    .groupBy(groupbuyGroups.activityId);
  return new Map(rows.map((row) => [row.activityId, row.value]));
}

/**
 * The 人气条 over every live activity.
 *
 * "In a team" means a member who has not left (`joined`), in a group that is
 * still `forming` or already `succeeded`. A `failed` or `cancelled` team is not
 * somebody currently taking part, and a `refunded` member left — counting
 * either is how a 人气条 ends up larger than the shop's whole customer base.
 *
 * Distinct **users**, not rows: one person who joined three teams is one
 * participant.
 */
function livePinkWhere(now: Date): SQL | undefined {
  return and(
    eq(groupbuyMembers.status, 'joined'),
    inArray(groupbuyGroups.status, ['forming', 'succeeded']),
    isNull(groupbuyActivities.deletedAt),
    eq(groupbuyActivities.status, 'active'),
    lte(groupbuyActivities.startAt, now),
    gt(groupbuyActivities.endAt, now),
  );
}

export async function countLiveParticipants(db: DbOrTx, now: Date): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(distinct ${groupbuyMembers.userId})::int` })
    .from(groupbuyMembers)
    .innerJoin(groupbuyGroups, eq(groupbuyGroups.id, groupbuyMembers.groupId))
    .innerJoin(groupbuyActivities, eq(groupbuyActivities.id, groupbuyGroups.activityId))
    .where(livePinkWhere(now));
  return row?.value ?? 0;
}

/**
 * 注销: every membership the user held stays — the team's seats, its orders
 * and its refunds depend on it — with no nickname or avatar on it.
 */
export async function clearMemberIdentityOf(
  tx: Tx,
  args: { userId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyMembers, {
    where: and(
      eq(groupbuyMembers.userId, args.userId),
      or(isNotNull(groupbuyMembers.nickname), isNotNull(groupbuyMembers.avatarUrl)),
    ),
    set: { nickname: null, avatarUrl: null, updatedAt: args.now },
  });
}

/**
 * The faces on the 人气条: the most recent distinct participants who have one.
 *
 * `DISTINCT ON (user_id)` picks each user's latest membership, and the outer
 * query then orders those by recency and takes the first `limit`. Doing it the
 * other way round — take the latest N rows, then dedupe — would quietly return
 * fewer than `limit` faces whenever one enthusiastic shopper occupied the top
 * of the list.
 *
 * The avatar is the one frozen on `groupbuy_members` at join time, not the
 * user's current one, so the strip does not change under a shopper who edited
 * their profile. 注销 blanks it (`clearMemberIdentityOf`), and a blank is
 * skipped here rather than drawn as an empty face.
 */
export async function listLiveParticipantAvatars(
  db: DbOrTx,
  args: { now: Date; limit: number },
): Promise<string[]> {
  const latest = db
    .selectDistinctOn([groupbuyMembers.userId], {
      userId: groupbuyMembers.userId,
      memberId: groupbuyMembers.id,
      avatarUrl: groupbuyMembers.avatarUrl,
    })
    .from(groupbuyMembers)
    .innerJoin(groupbuyGroups, eq(groupbuyGroups.id, groupbuyMembers.groupId))
    .innerJoin(groupbuyActivities, eq(groupbuyActivities.id, groupbuyGroups.activityId))
    .where(
      and(
        livePinkWhere(args.now),
        isNotNull(groupbuyMembers.avatarUrl),
        ne(groupbuyMembers.avatarUrl, ''),
      ),
    )
    .orderBy(asc(groupbuyMembers.userId), desc(groupbuyMembers.id))
    .as('latest');

  const rows = await db
    .select({ avatarUrl: latest.avatarUrl })
    .from(latest)
    .orderBy(desc(latest.memberId))
    .limit(args.limit);
  return rows.map((row) => row.avatarUrl).filter((url): url is string => url !== null);
}

export async function bumpViews(db: DbOrTx, activityId: number): Promise<void> {
  await conditionalUpdate(db, groupbuyActivities, {
    where: eq(groupbuyActivities.id, activityId),
    set: { views: sql`${groupbuyActivities.views} + 1` },
  });
}

// ---------------------------------------------------------------------------
// activity SKUs
// ---------------------------------------------------------------------------

export interface ActivitySkuRow {
  id: number;
  activityId: number;
  skuId: number;
  price: string;
  stock: number;
  sales: number;
  quota: number | null;
  isEnabled: boolean;
  specText: string;
  specValues: Record<string, string>;
  imageUrl: string | null;
  skuPrice: string;
  skuOriginalPrice: string | null;
  skuStock: number;
}

const activitySkuSelection = {
  id: groupbuyActivitySkus.id,
  activityId: groupbuyActivitySkus.activityId,
  skuId: groupbuyActivitySkus.skuId,
  price: groupbuyActivitySkus.price,
  stock: groupbuyActivitySkus.stock,
  sales: groupbuyActivitySkus.sales,
  quota: groupbuyActivitySkus.quota,
  isEnabled: groupbuyActivitySkus.isEnabled,
  specText: productSkus.specText,
  specValues: productSkus.specValues,
  imageUrl: productSkus.imageUrl,
  skuPrice: productSkus.price,
  skuOriginalPrice: productSkus.originalPrice,
  skuStock: productSkus.stock,
} as const;

export async function listActivitySkus(
  db: DbOrTx,
  activityIds: readonly number[],
): Promise<ActivitySkuRow[]> {
  if (activityIds.length === 0) return [];
  return db
    .select(activitySkuSelection)
    .from(groupbuyActivitySkus)
    .innerJoin(productSkus, eq(productSkus.id, groupbuyActivitySkus.skuId))
    .where(inArray(groupbuyActivitySkus.activityId, [...activityIds]))
    .orderBy(asc(groupbuyActivitySkus.id));
}

export async function findActivitySku(
  db: DbOrTx,
  args: { activityId: number; skuId: number },
): Promise<ActivitySkuRow | null> {
  const [row] = await db
    .select(activitySkuSelection)
    .from(groupbuyActivitySkus)
    .innerJoin(productSkus, eq(productSkus.id, groupbuyActivitySkus.skuId))
    .where(
      and(
        eq(groupbuyActivitySkus.activityId, args.activityId),
        eq(groupbuyActivitySkus.skuId, args.skuId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface ActivitySkuInput {
  skuId: number;
  price: string;
  stock: number;
  quota: number | null;
  isEnabled: boolean;
}

/**
 * The activity's status and stock and every SKU's stock, locked for the rest
 * of the edit's transaction: an order decrementing either waits, so what the
 * edit compares against is what it overwrites.
 */
export async function lockActivityStock(
  tx: Tx,
  id: number,
): Promise<{ status: string; stock: number; skus: Map<number, number> } | null> {
  const [activity] = await tx
    .select({ status: groupbuyActivities.status, stock: groupbuyActivities.stock })
    .from(groupbuyActivities)
    .where(and(eq(groupbuyActivities.id, id), isNull(groupbuyActivities.deletedAt)))
    .for('update');
  if (!activity) return null;
  const skus = await tx
    .select({ skuId: groupbuyActivitySkus.skuId, stock: groupbuyActivitySkus.stock })
    .from(groupbuyActivitySkus)
    .where(eq(groupbuyActivitySkus.activityId, id))
    .for('update');
  return { ...activity, skus: new Map(skus.map((row) => [row.skuId, row.stock])) };
}

/**
 * The activity SKUs an edit would delete that orders still depend on: units already sold, or
 * a live seat whose order buys that SKU (an unpaid order still has to commit its activity
 * stock when it is paid). Deleting one would reset its 已售 and quota on a re-add and refund
 * the order being paid; the service refuses the edit with a typed 409 instead.
 */
export async function listRemovedSkusInUse(
  tx: Tx,
  args: { activityId: number; keep: readonly number[] },
): Promise<number[]> {
  const rows = await tx
    .select({ skuId: groupbuyActivitySkus.skuId })
    .from(groupbuyActivitySkus)
    .where(
      and(
        eq(groupbuyActivitySkus.activityId, args.activityId),
        args.keep.length > 0 ? notInArray(groupbuyActivitySkus.skuId, [...args.keep]) : undefined,
        or(
          gt(groupbuyActivitySkus.sales, 0),
          exists(
            tx
              .select({ one: sql`1` })
              .from(groupbuyMembers)
              .innerJoin(groupbuyGroups, eq(groupbuyGroups.id, groupbuyMembers.groupId))
              .innerJoin(orderItems, eq(orderItems.orderId, groupbuyMembers.orderId))
              .innerJoin(orders, eq(orders.id, groupbuyMembers.orderId))
              .where(
                and(
                  eq(groupbuyGroups.activityId, groupbuyActivitySkus.activityId),
                  eq(orderItems.skuId, groupbuyActivitySkus.skuId),
                  eq(groupbuyMembers.status, 'joined'),
                  notInArray(orders.status, ['cancelled', 'refunded']),
                ),
              ),
          ),
        ),
      ),
    );
  return rows.map((row) => row.skuId);
}

/**
 * Upserts the rows the form names and deletes the rest.
 *
 * `sales` is never in the `set`: it is the server's running total and an edit
 * must not reset it. `stock` is, because the operator is restating how many
 * units this campaign may still sell.
 */
export async function replaceActivitySkus(
  tx: Tx,
  args: { activityId: number; skus: readonly ActivitySkuInput[] },
): Promise<void> {
  const keep = args.skus.map((sku) => sku.skuId);
  await tx
    .delete(groupbuyActivitySkus)
    .where(
      keep.length > 0
        ? and(
            eq(groupbuyActivitySkus.activityId, args.activityId),
            notInArray(groupbuyActivitySkus.skuId, keep),
          )
        : eq(groupbuyActivitySkus.activityId, args.activityId),
    );
  for (const sku of args.skus) {
    await tx
      .insert(groupbuyActivitySkus)
      .values({
        activityId: args.activityId,
        skuId: sku.skuId,
        price: sku.price,
        stock: sku.stock,
        quota: sku.quota,
        isEnabled: sku.isEnabled,
      })
      .onConflictDoUpdate({
        target: [groupbuyActivitySkus.activityId, groupbuyActivitySkus.skuId],
        set: { price: sku.price, stock: sku.stock, quota: sku.quota, isEnabled: sku.isEnabled },
      });
  }
}

/** The product's long HTML body, for the storefront activity page. */
export async function findProductDescription(
  db: DbOrTx,
  productId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ html: productDescriptions.contentHtml })
    .from(productDescriptions)
    .where(eq(productDescriptions.productId, productId))
    .limit(1);
  return row?.html ?? null;
}

/** Are the SKUs really this product's? Guards against a hand-crafted form body. */
export async function skuIdsOfProduct(db: DbOrTx, productId: number): Promise<number[]> {
  const rows = await db
    .select({ id: productSkus.id })
    .from(productSkus)
    .where(eq(productSkus.productId, productId));
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// activity stock — the campaign's own counters (invariant STOCK-004)
// ---------------------------------------------------------------------------

/**
 * Takes `quantity` off the activity SKU row and then the activity row, each in
 * one statement carrying `stock >= quantity` and the quota in its `WHERE`.
 *
 * The quota is part of the same `UPDATE`: checking it with a separate `SELECT`
 * and then decrementing oversells under load.
 *
 * `false` means one of the two changed nothing. The caller is inside the order
 * transaction and throws, which rolls the other one back — a half-applied
 * reservation cannot survive.
 */
export async function reserveActivityStock(
  tx: Tx,
  args: { activityId: number; skuId: number; quantity: number },
): Promise<boolean> {
  const sku = await conditionalUpdate(tx, groupbuyActivitySkus, {
    where: and(
      eq(groupbuyActivitySkus.activityId, args.activityId),
      eq(groupbuyActivitySkus.skuId, args.skuId),
      eq(groupbuyActivitySkus.isEnabled, true),
      sql`${groupbuyActivitySkus.stock} >= ${args.quantity}`,
      sql`(${groupbuyActivitySkus.quota} is null or ${groupbuyActivitySkus.sales} + ${args.quantity} <= ${groupbuyActivitySkus.quota})`,
    ),
    set: { stock: sql`${groupbuyActivitySkus.stock} - ${args.quantity}` },
  });
  if (!sku.won) return false;

  const activity = await conditionalUpdate(tx, groupbuyActivities, {
    where: and(
      eq(groupbuyActivities.id, args.activityId),
      sql`${groupbuyActivities.stock} >= ${args.quantity}`,
      sql`(${groupbuyActivities.totalQuota} is null or ${groupbuyActivities.sales} + ${args.quantity} <= ${groupbuyActivities.totalQuota})`,
    ),
    set: { stock: sql`${groupbuyActivities.stock} - ${args.quantity}` },
  });
  return activity.won;
}

/**
 * Puts the units back. `soldToo` also walks `sales` down — the refund path,
 * where the reservation had already been turned into a sale.
 */
export async function releaseActivityStock(
  tx: Tx,
  args: { activityId: number; skuId: number; quantity: number; soldToo: boolean },
): Promise<void> {
  await conditionalUpdate(tx, groupbuyActivitySkus, {
    where: and(
      eq(groupbuyActivitySkus.activityId, args.activityId),
      eq(groupbuyActivitySkus.skuId, args.skuId),
    ),
    set: {
      stock: sql`${groupbuyActivitySkus.stock} + ${args.quantity}`,
      ...(args.soldToo
        ? { sales: sql`greatest(0, ${groupbuyActivitySkus.sales} - ${args.quantity})` }
        : {}),
    },
  });
  await conditionalUpdate(tx, groupbuyActivities, {
    where: eq(groupbuyActivities.id, args.activityId),
    set: {
      stock: sql`${groupbuyActivities.stock} + ${args.quantity}`,
      ...(args.soldToo
        ? { sales: sql`greatest(0, ${groupbuyActivities.sales} - ${args.quantity})` }
        : {}),
    },
  });
}

/**
 * Turns a reservation into a sale: stock stays down, `sales` goes up.
 *
 * The quota is guarded here as well as at reservation time, and this is the
 * guard that actually holds. `total_quota` is "units this activity may ever
 * sell", and `sales` only moves when money arrives — so a reservation-time
 * check alone lets N unpaid orders through a quota of one and oversells it the
 * moment they all pay. The `WHERE` here is the one statement where `sales`
 * changes, so putting the ceiling in it makes the promise unbreakable.
 *
 * Returns false when the quota is already spent; the caller then refunds,
 * exactly as it does for a lost seat.
 */
export async function commitActivitySales(
  tx: Tx,
  args: { activityId: number; skuId: number; quantity: number },
): Promise<boolean> {
  const sku = await conditionalUpdate(tx, groupbuyActivitySkus, {
    where: and(
      eq(groupbuyActivitySkus.activityId, args.activityId),
      eq(groupbuyActivitySkus.skuId, args.skuId),
      sql`(${groupbuyActivitySkus.quota} is null or ${groupbuyActivitySkus.sales} + ${args.quantity} <= ${groupbuyActivitySkus.quota})`,
    ),
    set: { sales: sql`${groupbuyActivitySkus.sales} + ${args.quantity}` },
  });
  if (!sku.won) return false;

  const activity = await conditionalUpdate(tx, groupbuyActivities, {
    where: and(
      eq(groupbuyActivities.id, args.activityId),
      sql`(${groupbuyActivities.totalQuota} is null or ${groupbuyActivities.sales} + ${args.quantity} <= ${groupbuyActivities.totalQuota})`,
    ),
    set: { sales: sql`${groupbuyActivities.sales} + ${args.quantity}` },
  });
  if (activity.won) return true;

  // The SKU had room and the campaign did not. Both counters move together or
  // neither does, and this is inside the payment's own transaction, so undoing
  // the half that landed is a plain statement rather than a saga.
  await releaseActivitySales(tx, { ...args, skuOnly: true });
  return false;
}

/**
 * Undoes a `commitActivitySales` without touching stock: the units stay
 * reserved, they just stopped being sold. Used when one line of a multi-line
 * order is refused by the quota after its siblings were already counted.
 */
export async function releaseActivitySales(
  tx: Tx,
  args: { activityId: number; skuId: number; quantity: number; skuOnly?: boolean },
): Promise<void> {
  await conditionalUpdate(tx, groupbuyActivitySkus, {
    where: and(
      eq(groupbuyActivitySkus.activityId, args.activityId),
      eq(groupbuyActivitySkus.skuId, args.skuId),
    ),
    set: { sales: sql`greatest(0, ${groupbuyActivitySkus.sales} - ${args.quantity})` },
  });
  if (args.skuOnly) return;
  await conditionalUpdate(tx, groupbuyActivities, {
    where: eq(groupbuyActivities.id, args.activityId),
    set: { sales: sql`greatest(0, ${groupbuyActivities.sales} - ${args.quantity})` },
  });
}

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

export async function insertGroup(
  tx: Tx,
  values: typeof groupbuyGroups.$inferInsert,
): Promise<GroupbuyGroup> {
  const rows = await tx.insert(groupbuyGroups).values(values).returning();
  return rows[0]!;
}

export async function findGroup(db: DbOrTx, id: number): Promise<GroupbuyGroup | null> {
  const [row] = await db.select().from(groupbuyGroups).where(eq(groupbuyGroups.id, id)).limit(1);
  return row ?? null;
}

/** `SELECT … FOR UPDATE`. Used when leadership, seats and membership must agree. */
export async function lockGroup(tx: Tx, id: number): Promise<GroupbuyGroup | null> {
  const rows = await tx
    .select()
    .from(groupbuyGroups)
    .where(eq(groupbuyGroups.id, id))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/**
 * **The statement this domain exists for.**
 *
 * ```sql
 * UPDATE groupbuy_groups SET seats_taken = seats_taken + 1
 *  WHERE id = $1 AND status = 'forming' AND expires_at > $2
 *    AND seats_taken < seats_total
 * ```
 *
 * `affected === 0` means the seat was gone — the team filled, or it expired, or
 * it was cancelled. The caller must not ask which: by the time it asked, the
 * answer could have changed again.
 */
export async function takeSeat(
  tx: Tx,
  args: { groupId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyGroups, {
    where: and(
      eq(groupbuyGroups.id, args.groupId),
      eq(groupbuyGroups.status, 'forming'),
      gt(groupbuyGroups.expiresAt, args.now),
      sql`${groupbuyGroups.seatsTaken} < ${groupbuyGroups.seatsTotal}`,
    ),
    set: { seatsTaken: sql`${groupbuyGroups.seatsTaken} + 1`, updatedAt: args.now },
  });
}

/** Gives a seat back, guarded so the counter cannot go below zero. */
export async function freeSeat(
  tx: Tx,
  args: { groupId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyGroups, {
    where: and(eq(groupbuyGroups.id, args.groupId), sql`${groupbuyGroups.seatsTaken} > 0`),
    set: { seatsTaken: sql`${groupbuyGroups.seatsTaken} - 1`, updatedAt: args.now },
  });
}

/**
 * Completes a full group.
 *
 * `seats_taken = seats_total` is in the `WHERE` and not merely asserted before
 * the call, because `groupbuy_groups_succeeded_is_full` would abort the whole
 * transaction — and a CHECK violation is a 500 where a lost race is a no-op.
 */
export async function succeedGroup(
  tx: Tx,
  args: { groupId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyGroups, {
    where: and(
      eq(groupbuyGroups.id, args.groupId),
      eq(groupbuyGroups.status, 'forming'),
      sql`${groupbuyGroups.seatsTaken} = ${groupbuyGroups.seatsTotal}`,
    ),
    set: { status: 'succeeded', succeededAt: args.now, updatedAt: args.now },
  });
}

/**
 * 虚拟成团: fills the empty seats and completes, in one statement.
 *
 * `seats_taken >= 1` because a team nobody paid into is not a team — that one
 * fails instead.
 */
export async function virtuallyFillAndSucceed(
  tx: Tx,
  args: { groupId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyGroups, {
    where: and(
      eq(groupbuyGroups.id, args.groupId),
      eq(groupbuyGroups.status, 'forming'),
      sql`${groupbuyGroups.seatsTaken} >= 1`,
    ),
    set: {
      seatsTaken: sql`${groupbuyGroups.seatsTotal}`,
      status: 'succeeded',
      succeededAt: args.now,
      updatedAt: args.now,
    },
  });
}

export async function failGroup(
  tx: Tx,
  args: { groupId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyGroups, {
    where: and(eq(groupbuyGroups.id, args.groupId), eq(groupbuyGroups.status, 'forming')),
    set: { status: 'failed', failedAt: args.now, updatedAt: args.now },
  });
}

/** 取消我发起的团 — only a team nobody has paid into. */
export async function cancelEmptyGroup(
  tx: Tx,
  args: { groupId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyGroups, {
    where: and(
      eq(groupbuyGroups.id, args.groupId),
      eq(groupbuyGroups.status, 'forming'),
      eq(groupbuyGroups.seatsTaken, 0),
    ),
    set: { status: 'cancelled', updatedAt: args.now },
  });
}

export async function setGroupLeader(
  tx: Tx,
  args: { groupId: number; leaderUserId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyGroups, {
    where: eq(groupbuyGroups.id, args.groupId),
    set: { leaderUserId: args.leaderUserId, updatedAt: args.now },
  });
}

export interface GroupRow extends GroupbuyGroup {
  activityTitle: string;
  activityImageUrl: string | null;
  activityPrice: string;
  activityOriginalPrice: string | null;
  leaderNickname: string | null;
  leaderAvatarUrl: string | null;
  /** Members still in and paid. Below `seatsTaken` exactly when the team was faked. */
  realMembers: number;
}

/**
 * `real_members` is a correlated subquery rather than a stored column because
 * 虚拟成团 is the only thing that can make it differ from `seats_taken`, and a
 * stored "was this faked" flag would be one more thing to keep true. The
 * subquery cannot drift.
 */
const realMembers = sql<number>`(select count(*)::int from groupbuy_members m
                                  join orders o on o.id = m.order_id
                                 where m.group_id = ${groupbuyGroups.id}
                                   and m.status = 'joined'
                                   and o.paid_at is not null)`.mapWith(Number);

const groupSelection = {
  group: groupbuyGroups,
  activityTitle: groupbuyActivities.title,
  activityImageUrl: groupbuyActivities.imageUrl,
  activityPrice: groupbuyActivities.price,
  activityOriginalPrice: groupbuyActivities.originalPrice,
  leaderNickname: users.nickname,
  leaderAvatarUrl: users.avatarUrl,
  realMembers,
};

function toGroupRow(row: {
  group: GroupbuyGroup;
  activityTitle: string;
  activityImageUrl: string | null;
  activityPrice: string;
  activityOriginalPrice: string | null;
  leaderNickname: string | null;
  leaderAvatarUrl: string | null;
  realMembers: number;
}): GroupRow {
  const { group, ...rest } = row;
  return { ...group, ...rest };
}

export interface GroupListFilters {
  activityId?: number | undefined;
  statuses?: readonly GroupStatus[] | undefined;
  leaderUserId?: number | undefined;
  sortBy?: string | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  limit: number;
  offset: number;
}

const groupSort = {
  id: groupbuyGroups.id,
  createdAt: groupbuyGroups.createdAt,
  expiresAt: groupbuyGroups.expiresAt,
  seatsTaken: groupbuyGroups.seatsTaken,
} as const;

export async function listGroups(
  db: DbOrTx,
  filters: GroupListFilters,
): Promise<{ rows: GroupRow[]; total: number }> {
  const parts: (SQL | undefined)[] = [];
  if (filters.activityId !== undefined) {
    parts.push(eq(groupbuyGroups.activityId, filters.activityId));
  }
  if (filters.statuses && filters.statuses.length > 0) {
    parts.push(inArray(groupbuyGroups.status, [...filters.statuses]));
  }
  if (filters.leaderUserId !== undefined) {
    parts.push(eq(groupbuyGroups.leaderUserId, filters.leaderUserId));
  }
  const where = parts.length > 0 ? and(...parts) : undefined;
  const column = groupSort[filters.sortBy as keyof typeof groupSort] ?? groupSort.id;
  const direction = filters.sortOrder === 'asc' ? asc : desc;

  const rows = await db
    .select(groupSelection)
    .from(groupbuyGroups)
    .innerJoin(groupbuyActivities, eq(groupbuyActivities.id, groupbuyGroups.activityId))
    .leftJoin(users, eq(users.id, groupbuyGroups.leaderUserId))
    .where(where)
    .orderBy(direction(column))
    .limit(filters.limit)
    .offset(filters.offset);

  const [totalRow] = await db.select({ value: count() }).from(groupbuyGroups).where(where);
  return { rows: rows.map(toGroupRow), total: totalRow?.value ?? 0 };
}

export async function findGroupRow(db: DbOrTx, id: number): Promise<GroupRow | null> {
  const [row] = await db
    .select(groupSelection)
    .from(groupbuyGroups)
    .innerJoin(groupbuyActivities, eq(groupbuyActivities.id, groupbuyGroups.activityId))
    .leftJoin(users, eq(users.id, groupbuyGroups.leaderUserId))
    .where(eq(groupbuyGroups.id, id))
    .limit(1);
  return row ? toGroupRow(row) : null;
}

/**
 * Teams a shopper may join, nearest to complete first.
 *
 * `seats_taken >= 1` keeps a team whose leader has not paid yet off the list:
 * joining it would be joining nothing.
 */
export async function listOpenGroups(
  db: DbOrTx,
  args: { activityId: number; now: Date; limit: number; offset: number },
): Promise<{ rows: GroupRow[]; total: number }> {
  const where = and(
    eq(groupbuyGroups.activityId, args.activityId),
    eq(groupbuyGroups.status, 'forming'),
    gt(groupbuyGroups.expiresAt, args.now),
    sql`${groupbuyGroups.seatsTaken} >= 1`,
    sql`${groupbuyGroups.seatsTaken} < ${groupbuyGroups.seatsTotal}`,
  );
  const rows = await db
    .select(groupSelection)
    .from(groupbuyGroups)
    .innerJoin(groupbuyActivities, eq(groupbuyActivities.id, groupbuyGroups.activityId))
    .leftJoin(users, eq(users.id, groupbuyGroups.leaderUserId))
    .where(where)
    .orderBy(desc(groupbuyGroups.seatsTaken), asc(groupbuyGroups.expiresAt))
    .limit(args.limit)
    .offset(args.offset);
  const [totalRow] = await db.select({ value: count() }).from(groupbuyGroups).where(where);
  return { rows: rows.map(toGroupRow), total: totalRow?.value ?? 0 };
}

/** The expiry sweep. Reads `groupbuy_groups_expiry_idx` and nothing else. */
export async function findExpiredGroupIds(
  db: DbOrTx,
  args: { now: Date; limit: number },
): Promise<number[]> {
  const rows = await db
    .select({ id: groupbuyGroups.id })
    .from(groupbuyGroups)
    .where(and(eq(groupbuyGroups.status, 'forming'), lt(groupbuyGroups.expiresAt, args.now)))
    .orderBy(asc(groupbuyGroups.expiresAt))
    .limit(args.limit);
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------

export async function insertMember(
  tx: Tx,
  values: typeof groupbuyMembers.$inferInsert,
): Promise<GroupbuyMember> {
  const rows = await tx.insert(groupbuyMembers).values(values).returning();
  return rows[0]!;
}

/**
 * `groupbuy_members_group_user_uq`, `_order_uq` and `_leader_uq` are unique
 * indexes; PostgreSQL raises 23505 for each. A service turns that into
 * `GROUPBUY_ALREADY_IN_GROUP` rather than a 500.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

/** Each order's seat and its team, for 我的订单 (one read for a page of orders). */
export async function listTeamsByOrders(
  db: DbOrTx,
  orderIds: readonly number[],
): Promise<{ orderId: number; role: GroupbuyMember['role']; group: GroupbuyGroup }[]> {
  if (orderIds.length === 0) return [];
  const rows = await db
    .select({ orderId: groupbuyMembers.orderId, role: groupbuyMembers.role, group: groupbuyGroups })
    .from(groupbuyMembers)
    .innerJoin(groupbuyGroups, eq(groupbuyGroups.id, groupbuyMembers.groupId))
    .where(inArray(groupbuyMembers.orderId, [...orderIds]));
  return rows;
}

export async function findMemberByOrder(
  db: DbOrTx,
  orderId: number,
): Promise<GroupbuyMember | null> {
  const [row] = await db
    .select()
    .from(groupbuyMembers)
    .where(eq(groupbuyMembers.orderId, orderId))
    .limit(1);
  return row ?? null;
}

export async function findMember(
  db: DbOrTx,
  args: { groupId: number; userId: number },
): Promise<GroupbuyMember | null> {
  const [row] = await db
    .select()
    .from(groupbuyMembers)
    .where(and(eq(groupbuyMembers.groupId, args.groupId), eq(groupbuyMembers.userId, args.userId)))
    .limit(1);
  return row ?? null;
}

export interface MemberRow extends GroupbuyMember {
  orderNo: string;
  orderStatus: string;
  paid: boolean;
}

export async function listMembers(db: DbOrTx, groupId: number): Promise<MemberRow[]> {
  const rows = await db
    .select({
      member: groupbuyMembers,
      orderNo: orders.orderNo,
      orderStatus: orders.status,
      paidAt: orders.paidAt,
    })
    .from(groupbuyMembers)
    .innerJoin(orders, eq(orders.id, groupbuyMembers.orderId))
    .where(eq(groupbuyMembers.groupId, groupId))
    .orderBy(asc(groupbuyMembers.id));
  return rows.map((row) => ({
    ...row.member,
    orderNo: row.orderNo,
    orderStatus: row.orderStatus,
    paid: row.paidAt !== null,
  }));
}

/** Everything a notice about one member's order says: the order, the seat and the team. */
export interface MemberNoticeRow {
  orderId: number;
  orderNo: string;
  paidAmount: string | null;
  userId: number;
  role: 'leader' | 'member';
  memberStatus: MemberStatus;
  groupId: number;
  groupStatus: GroupStatus;
  seatsTotal: number;
  seatsTaken: number;
  expiresAt: Date;
  activityTitle: string;
}

export async function findMemberNotice(
  db: DbOrTx,
  orderId: number,
): Promise<MemberNoticeRow | null> {
  const [row] = await db
    .select({
      orderId: groupbuyMembers.orderId,
      orderNo: orders.orderNo,
      paidAmount: orders.paidAmount,
      userId: groupbuyMembers.userId,
      role: groupbuyMembers.role,
      memberStatus: groupbuyMembers.status,
      groupId: groupbuyGroups.id,
      groupStatus: groupbuyGroups.status,
      seatsTotal: groupbuyGroups.seatsTotal,
      seatsTaken: groupbuyGroups.seatsTaken,
      expiresAt: groupbuyGroups.expiresAt,
      activityTitle: groupbuyActivities.title,
    })
    .from(groupbuyMembers)
    .innerJoin(orders, eq(orders.id, groupbuyMembers.orderId))
    .innerJoin(groupbuyGroups, eq(groupbuyGroups.id, groupbuyMembers.groupId))
    .innerJoin(groupbuyActivities, eq(groupbuyActivities.id, groupbuyGroups.activityId))
    .where(eq(groupbuyMembers.orderId, orderId))
    .limit(1);
  return row ?? null;
}

/** Members who paid and are still in: the people the shop owes goods to. */
export async function listPaidMembers(db: DbOrTx, groupId: number): Promise<MemberRow[]> {
  const rows = await db
    .select({ member: groupbuyMembers, orderNo: orders.orderNo, orderStatus: orders.status })
    .from(groupbuyMembers)
    .innerJoin(orders, eq(orders.id, groupbuyMembers.orderId))
    .where(
      and(
        eq(groupbuyMembers.groupId, groupId),
        eq(groupbuyMembers.status, 'joined'),
        inArray(orders.status, [...PAID_ORDER_STATUSES]),
      ),
    )
    .orderBy(asc(groupbuyMembers.id));
  return rows.map((row) => ({
    ...row.member,
    orderNo: row.orderNo,
    orderStatus: row.orderStatus,
    paid: true,
  }));
}

/**
 * The member that inherits a team whose leader leaves: the earliest remaining
 * paid member, locked.
 *
 * Locked, because the demotion, the promotion and a concurrent join all have to
 * agree — `groupbuy_members_leader_uq` is a partial unique index, so two
 * simultaneous promotions would be a 23505 instead of a wait.
 */
export async function findSuccessorLocked(
  tx: Tx,
  args: { groupId: number; excludeMemberId: number; paidOnly: boolean },
): Promise<GroupbuyMember | null> {
  const parts: (SQL | undefined)[] = [
    eq(groupbuyMembers.groupId, args.groupId),
    eq(groupbuyMembers.status, 'joined'),
    ne(groupbuyMembers.id, args.excludeMemberId),
  ];
  // The refund path hands the team to somebody who has actually paid; the
  // cancel path only needs *a* leader, because on that path nobody has.
  if (args.paidOnly) parts.push(inArray(orders.status, [...PAID_ORDER_STATUSES]));
  const rows = await tx
    .select({ member: groupbuyMembers })
    .from(groupbuyMembers)
    .innerJoin(orders, eq(orders.id, groupbuyMembers.orderId))
    .where(and(...parts))
    .orderBy(asc(groupbuyMembers.id))
    .limit(1)
    .for('update', { of: groupbuyMembers });
  return rows[0]?.member ?? null;
}

/** joined → cancelled / refunded. `affected === 0` means somebody was first. */
export async function leaveMember(
  tx: Tx,
  args: { memberId: number; status: Exclude<MemberStatus, 'joined'>; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyMembers, {
    where: and(eq(groupbuyMembers.id, args.memberId), eq(groupbuyMembers.status, 'joined')),
    set: { status: args.status, leftAt: args.now, updatedAt: args.now },
  });
}

export async function promoteMember(
  tx: Tx,
  args: { memberId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, groupbuyMembers, {
    where: and(
      eq(groupbuyMembers.id, args.memberId),
      eq(groupbuyMembers.status, 'joined'),
      eq(groupbuyMembers.role, 'member'),
    ),
    set: { role: 'leader', updatedAt: args.now },
  });
}

export async function countJoinedMembers(db: DbOrTx, groupId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(groupbuyMembers)
    .where(and(eq(groupbuyMembers.groupId, groupId), eq(groupbuyMembers.status, 'joined')));
  return row?.value ?? 0;
}

export interface MyGroupRow extends GroupbuyMember {
  activityId: number;
  activityTitle: string;
  activityImageUrl: string | null;
  groupStatus: GroupStatus;
  seatsTotal: number;
  seatsTaken: number;
  expiresAt: Date;
  orderNo: string;
}

export async function listMyGroups(
  db: DbOrTx,
  args: {
    userId: number;
    status?: GroupStatus | undefined;
    limit: number;
    offset: number;
  },
): Promise<{ rows: MyGroupRow[]; total: number }> {
  const parts: (SQL | undefined)[] = [eq(groupbuyMembers.userId, args.userId)];
  if (args.status) parts.push(eq(groupbuyGroups.status, args.status));
  const where = and(...parts);

  const rows = await db
    .select({
      member: groupbuyMembers,
      group: groupbuyGroups,
      activityTitle: groupbuyActivities.title,
      activityImageUrl: groupbuyActivities.imageUrl,
      orderNo: orders.orderNo,
    })
    .from(groupbuyMembers)
    .innerJoin(groupbuyGroups, eq(groupbuyGroups.id, groupbuyMembers.groupId))
    .innerJoin(groupbuyActivities, eq(groupbuyActivities.id, groupbuyGroups.activityId))
    .innerJoin(orders, eq(orders.id, groupbuyMembers.orderId))
    .where(where)
    .orderBy(desc(groupbuyMembers.id))
    .limit(args.limit)
    .offset(args.offset);

  const [totalRow] = await db
    .select({ value: count() })
    .from(groupbuyMembers)
    .innerJoin(groupbuyGroups, eq(groupbuyGroups.id, groupbuyMembers.groupId))
    .where(where);

  return {
    rows: rows.map((row) => ({
      ...row.member,
      activityId: row.group.activityId,
      activityTitle: row.activityTitle,
      activityImageUrl: row.activityImageUrl,
      groupStatus: row.group.status,
      seatsTotal: row.group.seatsTotal,
      seatsTaken: row.group.seatsTaken,
      expiresAt: row.group.expiresAt,
      orderNo: row.orderNo,
    })),
    total: totalRow?.value ?? 0,
  };
}

/** The live team this shopper is already in for an activity, if any. */
export async function findMyOpenGroup(
  db: DbOrTx,
  args: { activityId: number; userId: number; now: Date },
): Promise<{ id: number; role: GroupbuyMember['role'] } | null> {
  const [row] = await db
    .select({ id: groupbuyGroups.id, role: groupbuyMembers.role })
    .from(groupbuyGroups)
    .innerJoin(groupbuyMembers, eq(groupbuyMembers.groupId, groupbuyGroups.id))
    .where(
      and(
        eq(groupbuyGroups.activityId, args.activityId),
        eq(groupbuyGroups.status, 'forming'),
        gt(groupbuyGroups.expiresAt, args.now),
        eq(groupbuyMembers.userId, args.userId),
        eq(groupbuyMembers.status, 'joined'),
      ),
    )
    .orderBy(desc(groupbuyGroups.id))
    .limit(1);
  return row ?? null;
}

/** Identity is frozen onto the member row, so a later rename cannot rewrite history. */
export async function findUserIdentity(
  db: DbOrTx,
  userId: number,
): Promise<{ nickname: string | null; avatarUrl: string | null } | null> {
  const [row] = await db
    .select({ nickname: users.nickname, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

/**
 * What the order's goods actually charge, after every adjustment the order
 * domain applied.
 *
 * The other half of the activity-price guard. `order_items.total_amount` is the
 * line subtotal minus its share of the discounts, and it is the only place the
 * 拼团价 can be read back from once it has been through the pricing pipeline —
 * the contributor books a *discount*, it does not rewrite the unit price.
 */
export async function orderGoodsCharged(db: DbOrTx, orderId: number): Promise<string> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${orderItems.totalAmount}), 0)::numeric(12, 2)` })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  return row?.total ?? '0.00';
}

/** What the order actually carries — the hooks are handed only an id. */
export async function orderLines(
  db: DbOrTx,
  orderId: number,
): Promise<{ skuId: number; quantity: number }[]> {
  return db
    .select({ skuId: orderItems.skuId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
}

// ---------------------------------------------------------------------------
// admin reporting
// ---------------------------------------------------------------------------

export interface ActivityStatRow {
  activityId: number;
  title: string;
  status: ActivityStatus;
  groups: number;
  formingGroups: number;
  succeededGroups: number;
  failedGroups: number;
  paidMembers: number;
  paidAmount: string;
  refundedMembers: number;
}

/**
 * Correlated subqueries rather than a pile of `LEFT JOIN … GROUP BY`: joining
 * groups and members in one pass multiplies the member count by the group count
 * and quietly reports nonsense. Several scans of an indexed `activity_id` beat
 * one wrong number.
 */
export async function statistics(
  db: DbOrTx,
  args: {
    activityId?: number | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    sortBy?: string | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
    limit: number;
    offset: number;
  },
): Promise<{ rows: ActivityStatRow[]; total: number }> {
  const parts: (SQL | undefined)[] = [isNull(groupbuyActivities.deletedAt)];
  if (args.activityId !== undefined) parts.push(eq(groupbuyActivities.id, args.activityId));
  const where = and(...parts);

  // The outer column must be written qualified: drizzle emits the select list
  // unqualified, and a bare `"id"` inside the subquery is ambiguous against
  // `groupbuy_groups g`.
  const outerId = sql`${groupbuyActivities}."id"`;

  const from = args.from ? sql` and g.created_at >= ${args.from}` : sql``;
  const to = args.to ? sql` and g.created_at <= ${args.to}` : sql``;

  const groupCount = (status?: GroupStatus) =>
    sql<number>`(select count(*)::int from groupbuy_groups g
                  where g.activity_id = ${outerId}${
                    status ? sql` and g.status = ${status}` : sql``
                  }${from}${to})`.mapWith(Number);

  const memberCount = (memberStatus: MemberStatus, paidOnly: boolean) =>
    sql<number>`(select count(*)::int from groupbuy_members m
                  join groupbuy_groups g on g.id = m.group_id
                  join orders o on o.id = m.order_id
                 where g.activity_id = ${outerId}
                   and m.status = ${memberStatus}${
                     paidOnly ? sql` and o.paid_at is not null` : sql``
                   }${from}${to})`.mapWith(Number);

  const paidAmount = sql<string>`(select coalesce(sum(o.payable_amount), 0)::numeric(12,2)
                                    from groupbuy_members m
                                    join groupbuy_groups g on g.id = m.group_id
                                    join orders o on o.id = m.order_id
                                   where g.activity_id = ${outerId}
                                     and m.status = 'joined'
                                     and o.paid_at is not null${from}${to})`.mapWith(String);

  const selection = {
    activityId: groupbuyActivities.id,
    title: groupbuyActivities.title,
    status: groupbuyActivities.status,
    groups: groupCount(),
    formingGroups: groupCount('forming'),
    succeededGroups: groupCount('succeeded'),
    failedGroups: groupCount('failed'),
    paidMembers: memberCount('joined', true),
    paidAmount,
    refundedMembers: memberCount('refunded', false),
  };

  const direction = args.sortOrder === 'asc' ? asc : desc;
  const sortable: Record<string, SQL> = {
    groups: selection.groups,
    paidMembers: selection.paidMembers,
    paidAmount: selection.paidAmount,
  };
  const orderColumn = args.sortBy ? sortable[args.sortBy] : undefined;

  const rows = await db
    .select(selection)
    .from(groupbuyActivities)
    .where(where)
    .orderBy(orderColumn ? direction(orderColumn) : desc(groupbuyActivities.id))
    .limit(args.limit)
    .offset(args.offset);

  const [totalRow] = await db.select({ value: count() }).from(groupbuyActivities).where(where);
  return { rows, total: totalRow?.value ?? 0 };
}

export interface ActivityOrderRow {
  orderId: number;
  orderNo: string;
  groupId: number;
  userId: number;
  nickname: string | null;
  role: 'leader' | 'member';
  memberStatus: MemberStatus;
  groupStatus: GroupStatus;
  quantity: number;
  payableAmount: string;
  paid: boolean;
  createdAt: Date;
}

export async function listActivityOrders(
  db: DbOrTx,
  args: {
    activityId: number;
    groupStatus?: GroupStatus | undefined;
    paid?: boolean | undefined;
    limit: number;
    offset: number;
  },
): Promise<{ rows: ActivityOrderRow[]; total: number }> {
  const parts: (SQL | undefined)[] = [eq(groupbuyGroups.activityId, args.activityId)];
  if (args.groupStatus) parts.push(eq(groupbuyGroups.status, args.groupStatus));
  if (args.paid === true) parts.push(sql`${orders.paidAt} is not null`);
  if (args.paid === false) parts.push(isNull(orders.paidAt));
  const where = and(...parts);

  const rows = await db
    .select({
      orderId: orders.id,
      orderNo: orders.orderNo,
      groupId: groupbuyMembers.groupId,
      userId: groupbuyMembers.userId,
      nickname: groupbuyMembers.nickname,
      role: groupbuyMembers.role,
      memberStatus: groupbuyMembers.status,
      groupStatus: groupbuyGroups.status,
      quantity: groupbuyMembers.quantity,
      payableAmount: orders.payableAmount,
      paidAt: orders.paidAt,
      createdAt: groupbuyMembers.createdAt,
    })
    .from(groupbuyMembers)
    .innerJoin(groupbuyGroups, eq(groupbuyGroups.id, groupbuyMembers.groupId))
    .innerJoin(orders, eq(orders.id, groupbuyMembers.orderId))
    .where(where)
    .orderBy(desc(groupbuyMembers.id))
    .limit(args.limit)
    .offset(args.offset);

  const [totalRow] = await db
    .select({ value: count() })
    .from(groupbuyMembers)
    .innerJoin(groupbuyGroups, eq(groupbuyGroups.id, groupbuyMembers.groupId))
    .innerJoin(orders, eq(orders.id, groupbuyMembers.orderId))
    .where(where);

  return {
    rows: rows.map(({ paidAt, ...row }) => ({ ...row, paid: paidAt !== null })),
    total: totalRow?.value ?? 0,
  };
}
