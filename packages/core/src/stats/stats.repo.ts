import { and, eq, gte, isNotNull, isNull, lt, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@shop/db';
import type { StatsBucket } from '@shop/contracts/stats/schemas';
import {
  productCategories,
  productCategoriesMap,
  productFavorites,
  products,
} from '@shop/db/schema/catalog';
import { orderItems, orders } from '@shop/db/schema/order';
import { refundItems, refunds } from '@shop/db/schema/refund';
import { productEvents, userVisits } from '@shop/db/schema/stats';
import { users } from '@shop/db/schema/user';
import { userAddresses } from '@shop/db/schema/user';

/**
 * Every figure the statistics screens draw, as `select` and nothing else.
 *
 * ## The one file allowed to read other domains' tables
 *
 * `docs/conventions.md` forbids reaching into another domain's tables; this
 * domain is the documented exception, and this file is where the exception
 * lives. That is only tolerable because of what is *not* here: no `insert`, no
 * `update`, no `delete`, no `withTx`, no conditional update, no lock. A
 * statistics domain that can write is a statistics domain that can corrupt an
 * order, and "read-only" has to be a property you can check by reading one file
 * rather than a promise made in a comment.
 *
 * The prices, states and rules those tables encode stay behind their own
 * domains: nothing here interprets `orders.status`, decides whether a refund
 * is allowed, or re-derives a price. It sums columns that other domains have
 * already decided are true, over windows.
 *
 * ## Shape
 *
 * Every aggregate takes `(db, args)` where `args.bucket` is either a bucket
 * size — one row per hour / day / month — or `'window'`, meaning "one row for
 * the whole window". Both go through the same SQL so a tile and its chart can
 * never drift apart and a dashboard tile never disagrees with the page it links
 * to. A distinct count is still computed per window rather than summed from the
 * buckets, because distinctness is not additive.
 *
 * All bucketing is `date_trunc(unit, ts at time zone 'Asia/Shanghai')` cast
 * back to an instant, so a boundary is a Shanghai midnight and not a UTC one.
 * Money comes back as `float8`: these are display aggregates read by a human
 * and drawn as a chart, never a figure anybody is charged (see the contract's
 * note in `contracts/src/stats/schemas.ts`).
 */

export type Bucketing = StatsBucket | 'window';

export interface WindowArgs {
  from: Date;
  to: Date;
  bucket: Bucketing;
}

/** A row of any aggregate. `bucket` is `null` for a `'window'` aggregate. */
export type Bucketed<T> = T & { bucket: Date | null };

// ---------------------------------------------------------------------------
// bucketing
// ---------------------------------------------------------------------------

const ZONE = sql`'Asia/Shanghai'`;

function truncated(column: AnyColumn, unit: StatsBucket): SQL<Date> {
  const literal = unit === 'hour' ? sql`'hour'` : unit === 'day' ? sql`'day'` : sql`'month'`;
  return sql<Date>`date_trunc(${literal}, ${column} at time zone ${ZONE}) at time zone ${ZONE}`;
}

/**
 * What a row is grouped by. For `'window'` it is the constant `null`, and the
 * query then carries no `GROUP BY` at all — which is also what makes an empty
 * window answer with one row of zeros instead of no rows, so a tile never has
 * to guess whether "nothing" means nothing happened or the query went wrong.
 */
function grouping(column: AnyColumn, bucket: Bucketing): SQL<Date | null> {
  if (bucket === 'window') return sql<Date | null>`cast(null as timestamptz)`;
  return truncated(column, bucket) as unknown as SQL<Date | null>;
}

const amount = (expression: AnyColumn): SQL<number> =>
  sql<number>`coalesce(sum(${expression}), 0)::float8`;

// ---------------------------------------------------------------------------
// populations, as reusable predicates
// ---------------------------------------------------------------------------

/** Paid, not deleted by an operator, paid inside the window. */
function paidOrdersIn(from: Date, to: Date): SQL {
  return and(
    isNotNull(orders.paidAt),
    isNull(orders.deletedAt),
    gte(orders.paidAt, from),
    lt(orders.paidAt, to),
  ) as SQL;
}

/** Submitted inside the window, paid or not. */
function placedOrdersIn(from: Date, to: Date): SQL {
  return and(
    isNull(orders.deletedAt),
    gte(orders.createdAt, from),
    lt(orders.createdAt, to),
  ) as SQL;
}

function succeededRefundsIn(from: Date, to: Date): SQL {
  return and(
    eq(refunds.status, 'succeeded'),
    isNull(refunds.deletedAt),
    gte(refunds.succeededAt, from),
    lt(refunds.succeededAt, to),
    // A deleted order is out of every figure, its refunds included — counting
    // them alone would drive 营业额 below zero for money that was never in it.
    sql`exists (select 1 from ${orders} where ${orders.id} = ${refunds.orderId} and ${orders.deletedAt} is null)`,
  ) as SQL;
}

// ---------------------------------------------------------------------------
// orders and money
// ---------------------------------------------------------------------------

export interface PaidOrderRow {
  orderCount: number;
  paidAmount: number;
  freightAmount: number;
  payingUsers: number;
}

/** 支付订单数 / 订单销售额 / 运费收入 / 成交用户数, over paid orders. */
export async function paidOrderAggregate(
  db: DbOrTx,
  args: WindowArgs,
): Promise<Array<Bucketed<PaidOrderRow>>> {
  const bucket = grouping(orders.paidAt, args.bucket);
  const query = db
    .select({
      bucket,
      orderCount: sql<number>`count(*)::int`,
      paidAmount: amount(orders.paidAmount),
      freightAmount: amount(orders.freightAmount),
      payingUsers: sql<number>`count(distinct ${orders.userId})::int`,
    })
    .from(orders)
    .where(paidOrdersIn(args.from, args.to));
  return args.bucket === 'window' ? query : query.groupBy(bucket).orderBy(bucket);
}

export interface GoodsRow {
  quantity: number;
  goodsAmount: number;
}

/** 支付件数 / 商品支付金额: the lines of the paid orders of each bucket. */
export async function paidGoodsAggregate(
  db: DbOrTx,
  args: WindowArgs,
): Promise<Array<Bucketed<GoodsRow>>> {
  const bucket = grouping(orders.paidAt, args.bucket);
  const query = db
    .select({
      bucket,
      quantity: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
      goodsAmount: amount(orderItems.totalAmount),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(paidOrdersIn(args.from, args.to));
  return args.bucket === 'window' ? query : query.groupBy(bucket).orderBy(bucket);
}

/** 下单件数: the lines of the orders *submitted* in each bucket, paid or not. */
export async function placedGoodsAggregate(
  db: DbOrTx,
  args: WindowArgs,
): Promise<Array<Bucketed<{ quantity: number; orderCount: number }>>> {
  const bucket = grouping(orders.createdAt, args.bucket);
  const query = db
    .select({
      bucket,
      quantity: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
      orderCount: sql<number>`count(distinct ${orders.id})::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(placedOrdersIn(args.from, args.to));
  return args.bucket === 'window' ? query : query.groupBy(bucket).orderBy(bucket);
}

export interface RefundRow {
  refundAmount: number;
  refundOrderCount: number;
}

/** 退款金额 / 退款订单数, bucketed by the day the money went back. */
export async function refundAggregate(
  db: DbOrTx,
  args: WindowArgs,
): Promise<Array<Bucketed<RefundRow>>> {
  const bucket = grouping(refunds.succeededAt, args.bucket);
  const query = db
    .select({
      bucket,
      refundAmount: amount(refunds.refundedAmount),
      refundOrderCount: sql<number>`count(distinct ${refunds.orderId})::int`,
    })
    .from(refunds)
    .where(succeededRefundsIn(args.from, args.to));
  return args.bucket === 'window' ? query : query.groupBy(bucket).orderBy(bucket);
}

/** 退款件数. */
export async function refundQuantityAggregate(
  db: DbOrTx,
  args: WindowArgs,
): Promise<Array<Bucketed<{ quantity: number }>>> {
  const bucket = grouping(refunds.succeededAt, args.bucket);
  const query = db
    .select({
      bucket,
      quantity: sql<number>`coalesce(sum(${refundItems.quantity}), 0)::int`,
    })
    .from(refundItems)
    .innerJoin(refunds, eq(refunds.id, refundItems.refundId))
    .where(succeededRefundsIn(args.from, args.to));
  return args.bucket === 'window' ? query : query.groupBy(bucket).orderBy(bucket);
}

// ---------------------------------------------------------------------------
// breakdowns
// ---------------------------------------------------------------------------

export interface PlatformRow {
  platform: 'h5' | 'wechat_oa' | 'wechat_mini';
  orderCount: number;
  paidAmount: number;
}

/** 订单来源 / 下单来源, over the paid orders of the window. */
export async function platformBreakdown(
  db: DbOrTx,
  args: { from: Date; to: Date },
): Promise<PlatformRow[]> {
  return db
    .select({
      platform: orders.platform,
      orderCount: sql<number>`count(*)::int`,
      paidAmount: amount(orders.paidAmount),
    })
    .from(orders)
    .where(paidOrdersIn(args.from, args.to))
    .groupBy(orders.platform);
}

export interface KindRow {
  kind: 'normal' | 'groupbuy' | 'presale';
  orderCount: number;
  paidAmount: number;
}

/** 订单类型. */
export async function kindBreakdown(
  db: DbOrTx,
  args: { from: Date; to: Date },
): Promise<KindRow[]> {
  return db
    .select({
      kind: orders.kind,
      orderCount: sql<number>`count(*)::int`,
      paidAmount: amount(orders.paidAmount),
    })
    .from(orders)
    .where(paidOrdersIn(args.from, args.to))
    .groupBy(orders.kind);
}

export interface HourOfDayRow {
  /** 0–23, Shanghai. */
  hour: number;
  orderCount: number;
  paidAmount: number;
}

/**
 * 时段分布: paid orders by the Shanghai hour of `paid_at`, every day of the
 * window folded onto one 0–23 axis. Hours nothing was paid in are absent; the
 * service fills them with zeros.
 */
export async function paidByHourOfDay(
  db: DbOrTx,
  args: { from: Date; to: Date },
): Promise<HourOfDayRow[]> {
  const hour = sql<number>`extract(hour from ${orders.paidAt} at time zone ${ZONE})::int`;
  return db
    .select({
      hour,
      orderCount: sql<number>`count(*)::int`,
      paidAmount: amount(orders.paidAmount),
    })
    .from(orders)
    .where(paidOrdersIn(args.from, args.to))
    .groupBy(hour)
    .orderBy(hour);
}

export interface TopCategoryRow {
  /** `null` for lines whose product is in no category: 未分类. */
  categoryId: number | null;
  name: string | null;
  paidAmount: number;
  paidQuantity: number;
  orderCount: number;
}

/**
 * 分类销售: the lines of the window's paid orders, by the **top-level**
 * category their product is in **now**.
 *
 * `order_items` keeps no category, so this reads the product's current
 * `product_categories_map`. A category's root is the first id of its
 * materialised path (`/3/17/` → 3), or the category itself when its path is
 * `/`. The `distinct` on (product, root) makes a product filed under two
 * subcategories of one root count once there; a product under two roots counts
 * in both, which is why the rows can add up to more than 商品支付金额.
 */
export async function paidByTopCategory(
  db: DbOrTx,
  args: { from: Date; to: Date },
): Promise<TopCategoryRow[]> {
  const result = await db.execute(sql`
    with lines as (
      select ${orderItems.orderId} as order_id,
             ${orderItems.productId} as product_id,
             ${orderItems.quantity} as quantity,
             ${orderItems.totalAmount} as total_amount
        from ${orderItems}
        join ${orders} on ${orders.id} = ${orderItems.orderId}
       where ${paidOrdersIn(args.from, args.to)}
    ), roots as (
      select distinct m.product_id,
             coalesce(nullif(split_part(c.path, '/', 2), '')::bigint, c.id) as root_id
        from ${productCategoriesMap} m
        join ${productCategories} c on c.id = m.category_id
       where m.product_id in (select product_id from lines)
    )
    select r.root_id                                    as category_id,
           rc.name                                      as name,
           coalesce(sum(l.total_amount), 0)::float8     as paid_amount,
           coalesce(sum(l.quantity), 0)::int            as paid_quantity,
           count(distinct l.order_id)::int              as order_count
      from lines l
      left join roots r on r.product_id = l.product_id
      left join ${productCategories} rc on rc.id = r.root_id
     group by r.root_id, rc.name
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  return rows.map((row) => ({
    categoryId: row.category_id === null ? null : Number(row.category_id),
    name: row.name === null ? null : String(row.name),
    paidAmount: Number(row.paid_amount),
    paidQuantity: Number(row.paid_quantity),
    orderCount: Number(row.order_count),
  }));
}

// ---------------------------------------------------------------------------
// users and traffic
// ---------------------------------------------------------------------------

/** 新增用户. Cancelled accounts are included: the registration did happen. */
export async function registrationAggregate(
  db: DbOrTx,
  args: WindowArgs,
): Promise<Array<Bucketed<{ newUsers: number }>>> {
  const bucket = grouping(users.createdAt, args.bucket);
  const query = db
    .select({ bucket, newUsers: sql<number>`count(*)::int` })
    .from(users)
    .where(and(gte(users.createdAt, args.from), lt(users.createdAt, args.to)));
  return args.bucket === 'window' ? query : query.groupBy(bucket).orderBy(bucket);
}

/** 累计用户: live accounts that existed at `at`. A running total, so no window. */
export async function totalUsersAt(db: DbOrTx, at: Date): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(users)
    .where(and(lt(users.createdAt, at), isNull(users.deletedAt)));
  return rows[0]?.total ?? 0;
}

/**
 * 访客数 / 浏览量 / 平均停留时长.
 *
 * A visitor is a signed-in user or, failing that, an IP — the only identity
 * `user_visits` carries. The table is filled by the user domain's page-view
 * beacon (`POST /api/v1/visits`).
 *
 * `avgStayMs` averages only the views whose stay was reported: a view whose
 * page is still open, or whose hide report never arrived, has no stay rather
 * than a stay of zero, and counting it as zero would drag the figure down by
 * however many reports went missing. `0` when no view in the bucket has one.
 */
export async function visitAggregate(
  db: DbOrTx,
  args: WindowArgs,
): Promise<Array<Bucketed<{ pageViews: number; visitors: number; avgStayMs: number }>>> {
  const bucket = grouping(userVisits.createdAt, args.bucket);
  const query = db
    .select({
      bucket,
      pageViews: sql<number>`count(*)::int`,
      visitors: sql<number>`count(distinct coalesce(${userVisits.userId}::text, 'ip:' || coalesce(${userVisits.ip}, '?')))::int`,
      avgStayMs: sql<number>`coalesce(avg(${userVisits.stayMs}), 0)::float8`,
    })
    .from(userVisits)
    .where(and(gte(userVisits.createdAt, args.from), lt(userVisits.createdAt, args.to)));
  return args.bucket === 'window' ? query : query.groupBy(bucket).orderBy(bucket);
}

/**
 * 商品浏览量 / 商品访客数 / 加购件数.
 *
 * `view` rows are written by the catalog domain on every product detail read;
 * `cart` rows by the cart's add path, through `catalog.recordCartAdd` —
 * 加购件数 sums their `quantity`, so it is units added and not taps of the
 * button. Anonymous views count towards 浏览量 and never towards 访客数:
 * `product_events` has no session identity, and inventing one would make the
 * conversion rate a fiction.
 */
export async function productEventAggregate(
  db: DbOrTx,
  args: WindowArgs,
): Promise<Array<Bucketed<{ views: number; viewers: number; cartQuantity: number }>>> {
  const bucket = grouping(productEvents.createdAt, args.bucket);
  const query = db
    .select({
      bucket,
      views: sql<number>`count(*) filter (where ${productEvents.kind} = 'view')::int`,
      viewers: sql<number>`count(distinct ${productEvents.userId}) filter (where ${productEvents.kind} = 'view')::int`,
      cartQuantity: sql<number>`coalesce(sum(${productEvents.quantity}) filter (where ${productEvents.kind} = 'cart'), 0)::int`,
    })
    .from(productEvents)
    .where(and(gte(productEvents.createdAt, args.from), lt(productEvents.createdAt, args.to)));
  return args.bucket === 'window' ? query : query.groupBy(bucket).orderBy(bucket);
}

// ---------------------------------------------------------------------------
// product ranking
// ---------------------------------------------------------------------------

export interface ProductRankingRepoRow {
  productId: number;
  name: string;
  imageUrl: string | null;
  views: number;
  visitors: number;
  cartQuantity: number;
  orderQuantity: number;
  paidQuantity: number;
  paidAmount: number;
  favorites: number;
  payingVisitors: number;
}

const RANKING_SORTS = {
  views: sql`coalesce(v.views, 0)`,
  visitors: sql`coalesce(v.visitors, 0)`,
  cartQuantity: sql`coalesce(c.quantity, 0)`,
  orderQuantity: sql`coalesce(pl.quantity, 0)`,
  paidQuantity: sql`coalesce(pd.quantity, 0)`,
  paidAmount: sql`coalesce(pd.amount, 0)`,
  favorites: sql`coalesce(f.favorites, 0)`,
} as const;

export type RankingSortKey = keyof typeof RANKING_SORTS;

/**
 * 商品排行 — the per-product version of the same figures, in one query.
 *
 * Five grouped scans joined on the product id rather than one join of five
 * tables, because joining `order_items` to `product_events` first would
 * multiply every view by every line. `union` of the five key sets means a
 * product that was only *looked at* still ranks, which is the whole point of a
 * ranking that includes 浏览量 — and a product nothing happened to is absent
 * rather than a row of zeros.
 *
 * Sorted and cut in the database: the export asks for thousands of rows and
 * sorting those in Node after fetching every product with any activity is how
 * a statistics page takes a server down.
 */
export async function productRankingRows(
  db: DbOrTx,
  args: { from: Date; to: Date; sortBy: RankingSortKey; limit: number },
): Promise<ProductRankingRepoRow[]> {
  const sortExpression = RANKING_SORTS[args.sortBy];
  const { from, to } = args;

  const result = await db.execute(sql`
    with v as (
      select ${productEvents.productId} as product_id,
             count(*)::int as views,
             count(distinct ${productEvents.userId})::int as visitors
        from ${productEvents}
       where ${productEvents.kind} = 'view'
         and ${productEvents.createdAt} >= ${from} and ${productEvents.createdAt} < ${to}
       group by 1
    ), c as (
      select ${productEvents.productId} as product_id,
             coalesce(sum(${productEvents.quantity}), 0)::int as quantity
        from ${productEvents}
       where ${productEvents.kind} = 'cart'
         and ${productEvents.createdAt} >= ${from} and ${productEvents.createdAt} < ${to}
       group by 1
    ), pl as (
      select ${orderItems.productId} as product_id,
             coalesce(sum(${orderItems.quantity}), 0)::int as quantity
        from ${orderItems}
        join ${orders} on ${orders.id} = ${orderItems.orderId}
       where ${orders.deletedAt} is null
         and ${orders.createdAt} >= ${from} and ${orders.createdAt} < ${to}
       group by 1
    ), pd as (
      select ${orderItems.productId} as product_id,
             coalesce(sum(${orderItems.quantity}), 0)::int as quantity,
             coalesce(sum(${orderItems.totalAmount}), 0)::float8 as amount,
             count(distinct ${orders.userId})::int as paying_visitors
        from ${orderItems}
        join ${orders} on ${orders.id} = ${orderItems.orderId}
       where ${orders.paidAt} is not null and ${orders.deletedAt} is null
         and ${orders.paidAt} >= ${from} and ${orders.paidAt} < ${to}
       group by 1
    ), f as (
      select ${productFavorites.productId} as product_id, count(*)::int as favorites
        from ${productFavorites}
       where ${productFavorites.createdAt} >= ${from} and ${productFavorites.createdAt} < ${to}
       group by 1
    ), k as (
      select product_id from v
      union select product_id from c
      union select product_id from pl
      union select product_id from pd
      union select product_id from f
    )
    select p.id::int                          as product_id,
           p.name                             as name,
           p.image_url                        as image_url,
           coalesce(v.views, 0)::int          as views,
           coalesce(v.visitors, 0)::int       as visitors,
           coalesce(c.quantity, 0)::int       as cart_quantity,
           coalesce(pl.quantity, 0)::int      as order_quantity,
           coalesce(pd.quantity, 0)::int      as paid_quantity,
           coalesce(pd.amount, 0)::float8     as paid_amount,
           coalesce(f.favorites, 0)::int      as favorites,
           coalesce(pd.paying_visitors, 0)::int as paying_visitors
      from k
      join ${products} p on p.id = k.product_id
      left join v on v.product_id = k.product_id
      left join c on c.product_id = k.product_id
      left join pl on pl.product_id = k.product_id
      left join pd on pd.product_id = k.product_id
      left join f on f.product_id = k.product_id
     order by ${sortExpression} desc, p.id asc
     limit ${args.limit}
  `);

  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  return rows.map((row) => ({
    productId: Number(row.product_id),
    name: String(row.name),
    imageUrl: row.image_url === null ? null : String(row.image_url),
    views: Number(row.views),
    visitors: Number(row.visitors),
    cartQuantity: Number(row.cart_quantity),
    orderQuantity: Number(row.order_quantity),
    paidQuantity: Number(row.paid_quantity),
    paidAmount: Number(row.paid_amount),
    favorites: Number(row.favorites),
    payingVisitors: Number(row.paying_visitors),
  }));
}

/** How many products the ranking would return without the limit, for the export's `truncated`. */
export async function productRankingCount(
  db: DbOrTx,
  args: { from: Date; to: Date },
): Promise<number> {
  const { from, to } = args;
  const result = await db.execute(sql`
    select count(*)::int as total from (
      select ${productEvents.productId} as product_id
        from ${productEvents}
       where ${productEvents.createdAt} >= ${from} and ${productEvents.createdAt} < ${to}
         and ${productEvents.kind} in ('view', 'cart')
      union
      select ${orderItems.productId}
        from ${orderItems}
        join ${orders} on ${orders.id} = ${orderItems.orderId}
       where ${orders.deletedAt} is null
         and ((${orders.createdAt} >= ${from} and ${orders.createdAt} < ${to})
              or (${orders.paidAt} >= ${from} and ${orders.paidAt} < ${to}))
      union
      select ${productFavorites.productId}
        from ${productFavorites}
       where ${productFavorites.createdAt} >= ${from} and ${productFavorites.createdAt} < ${to}
    ) as k
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  return Number(rows[0]?.total ?? 0);
}

// ---------------------------------------------------------------------------
// regions
// ---------------------------------------------------------------------------

export interface RegionRepoRow {
  province: string;
  totalUsers: number;
  newUsers: number;
  visitors: number;
  paidAmount: number;
}

const REGION_SORTS = {
  totalUsers: sql`coalesce(u.total_users, 0)`,
  newUsers: sql`coalesce(u.new_users, 0)`,
  visitors: sql`coalesce(v.visitors, 0)`,
  paidAmount: sql`coalesce(o.paid_amount, 0)`,
} as const;

export type RegionSortKey = keyof typeof REGION_SORTS;

/**
 * 用户地域分布.
 *
 * Each column brings its own notion of "province", spelled out in
 * `DEFINITIONS.md`: a user's is their default address, a visit's is the
 * visitor's default address when the view was recorded (anonymous views have
 * none), and an order's is where the goods were sent.
 * Pretending one join could serve all three would mean quietly dropping every
 * buyer without a saved address.
 *
 * `未知` collects the rows whose province is unknown and is sorted last
 * whatever the sort key, so it can never crowd the real provinces out of a
 * top-ten.
 */
export async function regionRows(
  db: DbOrTx,
  args: { from: Date; to: Date; sortBy: RegionSortKey; limit: number },
): Promise<RegionRepoRow[]> {
  const sortExpression = REGION_SORTS[args.sortBy];
  const { from, to } = args;

  const result = await db.execute(sql`
    with u as (
      select coalesce(a.province_name, '未知') as province,
             count(*) filter (where ${users.deletedAt} is null)::int as total_users,
             count(*) filter (where ${users.createdAt} >= ${from} and ${users.createdAt} < ${to})::int as new_users
        from ${users}
        left join ${userAddresses} a
               on a.user_id = ${users.id} and a.is_default and a.deleted_at is null
       group by 1
    ), v as (
      select coalesce(${userVisits.province}, '未知') as province,
             count(distinct coalesce(${userVisits.userId}::text, 'ip:' || coalesce(${userVisits.ip}, '?')))::int as visitors
        from ${userVisits}
       where ${userVisits.createdAt} >= ${from} and ${userVisits.createdAt} < ${to}
       group by 1
    ), o as (
      select coalesce(nullif(${orders.receiverProvince}, ''), '未知') as province,
             coalesce(sum(${orders.paidAmount}), 0)::float8 as paid_amount
        from ${orders}
       where ${orders.paidAt} is not null and ${orders.deletedAt} is null
         and ${orders.paidAt} >= ${from} and ${orders.paidAt} < ${to}
       group by 1
    ), k as (
      select province from u
      union select province from v
      union select province from o
    )
    select k.province                       as province,
           coalesce(u.total_users, 0)::int  as total_users,
           coalesce(u.new_users, 0)::int    as new_users,
           coalesce(v.visitors, 0)::int     as visitors,
           coalesce(o.paid_amount, 0)::float8 as paid_amount
      from k
      left join u on u.province = k.province
      left join v on v.province = k.province
      left join o on o.province = k.province
     order by (k.province = '未知') asc, ${sortExpression} desc, k.province asc
     limit ${args.limit}
  `);

  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  return rows.map((row) => ({
    province: String(row.province),
    totalUsers: Number(row.total_users),
    newUsers: Number(row.new_users),
    visitors: Number(row.visitors),
    paidAmount: Number(row.paid_amount),
  }));
}
