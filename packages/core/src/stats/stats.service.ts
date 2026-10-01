import type {
  OrderStats,
  ProductRanking,
  ProductRankingQuery,
  ProductStats,
  SalesCategoryRow,
  SalesMetric,
  SalesStats,
  StatsBreakdown,
  StatsChart,
  StatsExportResult,
  StatsFormat,
  StatsMetric,
  StatsRangeQuery,
  StatsSeries,
  TradeStats,
  UserRegionQuery,
  UserRegionStats,
  UserStats,
} from '@shop/contracts/stats/schemas';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { toId } from '../kernel/ids';
import { cached } from './stats.cache';
import { statsConfig } from './stats.config';
import * as repo from './stats.repo';
import {
  rangeKey,
  resolveRange,
  statsExportFilename,
  yearAgoRange,
  type ResolvedRange,
} from './stats.range';

/**
 * The five statistics pages, the ranking, the three exports and the figures the
 * admin home page borrows.
 *
 * Read `DEFINITIONS.md` next door first: this file computes, it does not
 * decide. Every figure's meaning is settled there, and the point of writing it
 * down is that pages left alone each invent their own — three screens, three
 * numbers for one day, and no way to tell which one to believe.
 *
 * Three rules hold everywhere below:
 *
 * 1. **A tile and its chart come from the same SQL**, with the bucket as the
 *    only difference. A tile is never the sum of its chart's buckets, because a
 *    distinct count (访客数, 成交用户数) is not additive and summing it
 *    over-counts every returning visitor.
 * 2. **`previous` is the same query over the window immediately before.** Not
 *    an estimate, not last month's stored total.
 * 3. **Nothing is invented.** A bucket where nothing happened is a true zero;
 *    a figure whose feature was retired is absent from the response rather
 *    than present as zero.
 */

// ---------------------------------------------------------------------------
// small shared arithmetic
// ---------------------------------------------------------------------------

/** Two decimals, and never `-0` or `1.0000000000000002`. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100 + 0;
}

/** A share of a whole, 0–100 with two decimals. `0` when the whole is zero. */
function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : round2((part / whole) * 100);
}

function metric(
  key: string,
  label: string,
  format: StatsFormat,
  value: number,
  previous: number | null,
): StatsMetric {
  return {
    key,
    label,
    format,
    value: round2(value),
    previous: previous === null ? null : round2(previous),
  };
}

function series(
  name: string,
  format: StatsFormat,
  shape: 'line' | 'bar',
  values: number[],
): StatsSeries {
  return { name, format, shape, values: values.map(round2) };
}

/** The single row a `'window'` aggregate answers with, or zeros if it answered with none. */
function only<T>(rows: Array<repo.Bucketed<T>>, zero: T): T {
  return rows[0] ?? zero;
}

/**
 * Bucketed rows onto the window's bucket list.
 *
 * The range decides the buckets, not the data: a day nothing was sold still
 * has a point, at zero, so a chart's gaps are visible instead of being closed
 * up into a line that implies business on a day there was none.
 */
function align<T>(
  range: ResolvedRange,
  rows: Array<repo.Bucketed<T>>,
  pick: (row: T) => number,
): number[] {
  const byBucket = new Map<number, number>();
  for (const row of rows) {
    if (row.bucket === null) continue;
    byBucket.set(new Date(row.bucket).getTime(), pick(row));
  }
  return range.bucketStarts.map((start) => byBucket.get(start.getTime()) ?? 0);
}

function chart(range: ResolvedRange, all: StatsSeries[]): StatsChart {
  return { bucket: range.bucket, buckets: range.buckets, series: all };
}

function envelope(ctx: Ctx, range: ResolvedRange) {
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    generatedAt: ctx.clock.now().toISOString(),
  };
}

const PLATFORM_LABELS: Record<string, string> = {
  h5: 'H5',
  wechat_oa: '公众号',
  wechat_mini: '小程序',
};

const KIND_LABELS: Record<string, string> = {
  normal: '普通订单',
  groupbuy: '拼团订单',
  presale: '预售订单',
};

function breakdown(
  key: string,
  label: string,
  format: StatsFormat,
  labels: Record<string, string>,
  rows: Array<{ key: string; value: number }>,
): StatsBreakdown {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return {
    key,
    label,
    format,
    // Biggest first, and a category that never occurred is absent rather than
    // a 0 % slice: an empty slice in a pie chart is noise, not information.
    rows: rows
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((row) => ({
        key: row.key,
        label: labels[row.key] ?? row.key,
        value: round2(row.value),
        percent: percent(row.value, total),
      })),
  };
}

// ---------------------------------------------------------------------------
// the figure sets, each computed once and reused by tile and comparison
// ---------------------------------------------------------------------------

const ZERO_ORDERS = { orderCount: 0, paidAmount: 0, freightAmount: 0, payingUsers: 0 };
const ZERO_GOODS = { quantity: 0, goodsAmount: 0 };
const ZERO_PLACED = { quantity: 0, orderCount: 0 };
const ZERO_REFUNDS = { refundAmount: 0, refundOrderCount: 0 };
const ZERO_QUANTITY = { quantity: 0 };
const ZERO_VISITS = { pageViews: 0, visitors: 0, avgStayMs: 0 };
const ZERO_EVENTS = { views: 0, viewers: 0, cartQuantity: 0 };

type Window = { from: Date; to: Date };

interface TradeFigures {
  paidAmount: number;
  freightAmount: number;
  orderCount: number;
  goodsAmount: number;
  /** 支付件数. */
  goodsQuantity: number;
  refundAmount: number;
  refundOrderCount: number;
}

async function tradeFigures(ctx: Ctx, window: Window): Promise<TradeFigures> {
  const [paid, goods, refunded] = await Promise.all([
    repo.paidOrderAggregate(ctx.db, { ...window, bucket: 'window' }),
    repo.paidGoodsAggregate(ctx.db, { ...window, bucket: 'window' }),
    repo.refundAggregate(ctx.db, { ...window, bucket: 'window' }),
  ]);
  const orders = only(paid, ZERO_ORDERS);
  const lines = only(goods, ZERO_GOODS);
  const refunds = only(refunded, ZERO_REFUNDS);
  return {
    paidAmount: orders.paidAmount,
    freightAmount: orders.freightAmount,
    orderCount: orders.orderCount,
    goodsAmount: lines.goodsAmount,
    goodsQuantity: lines.quantity,
    refundAmount: refunds.refundAmount,
    refundOrderCount: refunds.refundOrderCount,
  };
}

/** 营业额: what the gateway took, less what went back, both on their own day. */
const revenueOf = (figures: TradeFigures): number => figures.paidAmount - figures.refundAmount;

/** 客单价: 营业额 per paid order, `0` when nothing was paid. */
const averageOrderValueOf = (figures: TradeFigures): number =>
  figures.orderCount === 0 ? 0 : revenueOf(figures) / figures.orderCount;

/** 退款率: refunded orders per paid order, as a percentage. */
const refundRateOf = (figures: TradeFigures): number =>
  percent(figures.refundOrderCount, figures.orderCount);

/** 订单来源 by paid orders and 订单类型 by paid amount, shared by 订单统计 and 销售看板. */
function orderBreakdowns(platforms: repo.PlatformRow[], kinds: repo.KindRow[]): StatsBreakdown[] {
  return [
    breakdown(
      'platform',
      '订单来源',
      'count',
      PLATFORM_LABELS,
      platforms.map((row) => ({ key: row.platform, value: row.orderCount })),
    ),
    breakdown(
      'kind',
      '订单类型',
      'money',
      KIND_LABELS,
      kinds.map((row) => ({ key: row.kind, value: row.paidAmount })),
    ),
  ];
}

// ---------------------------------------------------------------------------
// 交易统计
// ---------------------------------------------------------------------------

export async function tradeStats(ctx: Ctx, input: StatsRangeQuery): Promise<TradeStats> {
  const range = resolveRange(input, ctx.clock);
  return cached(ctx, `trade:${rangeKey(range)}`, async () => {
    const [current, previous, paidSeries, goodsSeries, refundSeries] = await Promise.all([
      tradeFigures(ctx, range),
      tradeFigures(ctx, range.previous),
      repo.paidOrderAggregate(ctx.db, { ...range, bucket: range.bucket }),
      repo.paidGoodsAggregate(ctx.db, { ...range, bucket: range.bucket }),
      repo.refundAggregate(ctx.db, { ...range, bucket: range.bucket }),
    ]);

    const paidByBucket = align(range, paidSeries, (row) => row.paidAmount);
    const refundByBucket = align(range, refundSeries, (row) => row.refundAmount);

    return {
      ...envelope(ctx, range),
      metrics: [
        metric('revenue', '营业额', 'money', revenueOf(current), revenueOf(previous)),
        metric(
          'goodsPaidAmount',
          '商品支付金额',
          'money',
          current.goodsAmount,
          previous.goodsAmount,
        ),
        metric(
          'refundAmount',
          '商品退款金额',
          'money',
          current.refundAmount,
          previous.refundAmount,
        ),
        metric('freightAmount', '运费收入', 'money', current.freightAmount, previous.freightAmount),
        metric('paidOrderCount', '支付订单数', 'count', current.orderCount, previous.orderCount),
        metric(
          'averageOrderValue',
          '客单价',
          'money',
          averageOrderValueOf(current),
          averageOrderValueOf(previous),
        ),
      ],
      chart: chart(range, [
        series(
          '营业额',
          'money',
          'line',
          paidByBucket.map((paid, index) => paid - (refundByBucket[index] ?? 0)),
        ),
        series(
          '商品支付金额',
          'money',
          'line',
          align(range, goodsSeries, (row) => row.goodsAmount),
        ),
        series('商品退款金额', 'money', 'line', refundByBucket),
      ]),
    };
  });
}

// ---------------------------------------------------------------------------
// 订单统计
// ---------------------------------------------------------------------------

export async function orderStats(ctx: Ctx, input: StatsRangeQuery): Promise<OrderStats> {
  const range = resolveRange(input, ctx.clock);
  return cached(ctx, `orders:${rangeKey(range)}`, async () => {
    const [current, previous, paidSeries, refundSeries, platforms, kinds] = await Promise.all([
      tradeFigures(ctx, range),
      tradeFigures(ctx, range.previous),
      repo.paidOrderAggregate(ctx.db, { ...range, bucket: range.bucket }),
      repo.refundAggregate(ctx.db, { ...range, bucket: range.bucket }),
      repo.platformBreakdown(ctx.db, range),
      repo.kindBreakdown(ctx.db, range),
    ]);

    return {
      ...envelope(ctx, range),
      metrics: [
        metric('paidOrderCount', '订单量', 'count', current.orderCount, previous.orderCount),
        metric('paidAmount', '订单销售额', 'money', current.paidAmount, previous.paidAmount),
        metric(
          'refundOrderCount',
          '退款订单数',
          'count',
          current.refundOrderCount,
          previous.refundOrderCount,
        ),
        metric('refundAmount', '退款金额', 'money', current.refundAmount, previous.refundAmount),
        metric('refundRate', '退款率', 'percent', refundRateOf(current), refundRateOf(previous)),
      ],
      chart: chart(range, [
        series(
          '订单金额',
          'money',
          'line',
          align(range, paidSeries, (row) => row.paidAmount),
        ),
        series(
          '订单量',
          'count',
          'line',
          align(range, paidSeries, (row) => row.orderCount),
        ),
        series(
          '退款金额',
          'money',
          'line',
          align(range, refundSeries, (row) => row.refundAmount),
        ),
        series(
          '退款订单量',
          'count',
          'line',
          align(range, refundSeries, (row) => row.refundOrderCount),
        ),
      ]),
      breakdowns: orderBreakdowns(platforms, kinds),
    };
  });
}

// ---------------------------------------------------------------------------
// 销售看板
// ---------------------------------------------------------------------------

/** A tile with 环比 and 同比. */
function salesMetric(
  key: string,
  label: string,
  format: StatsFormat,
  pick: (figures: TradeFigures) => number,
  figures: { current: TradeFigures; previous: TradeFigures; yearAgo: TradeFigures },
): SalesMetric {
  return {
    ...metric(key, label, format, pick(figures.current), pick(figures.previous)),
    yearAgo: round2(pick(figures.yearAgo)),
  };
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Ranked by 支付金额, the id breaking ties so a reload keeps the order, 未分类 last. */
function categoryRows(rows: repo.TopCategoryRow[], goodsAmount: number): SalesCategoryRow[] {
  return [...rows]
    .sort((a, b) => {
      if (a.categoryId === null || b.categoryId === null) {
        return (a.categoryId === null ? 1 : 0) - (b.categoryId === null ? 1 : 0);
      }
      return b.paidAmount - a.paidAmount || a.categoryId - b.categoryId;
    })
    .map((row) => ({
      categoryId: row.categoryId === null ? null : toId(row.categoryId),
      name: row.categoryId === null ? '未分类' : (row.name ?? '未知分类'),
      paidAmount: round2(row.paidAmount),
      paidQuantity: row.paidQuantity,
      orderCount: row.orderCount,
      percent: percent(row.paidAmount, goodsAmount),
    }));
}

/**
 * 销售看板 — the sales figures of 交易统计 and 订单统计 on one screen.
 *
 * Every tile is the figure those pages show, from the same `tradeFigures`, so
 * 营业额 here and on 交易统计 cannot differ for one window. What this page adds
 * is 同比 (the same days a year earlier, `yearAgoRange`), 时段分布 and
 * 分类销售, each defined in `DEFINITIONS.md`.
 */
export async function salesStats(ctx: Ctx, input: StatsRangeQuery): Promise<SalesStats> {
  const range = resolveRange(input, ctx.clock);
  return cached(ctx, `sales:${rangeKey(range)}`, async () => {
    const [
      current,
      previous,
      yearAgo,
      paidSeries,
      refundSeries,
      hours,
      categories,
      platforms,
      kinds,
    ] = await Promise.all([
      tradeFigures(ctx, range),
      tradeFigures(ctx, range.previous),
      tradeFigures(ctx, yearAgoRange(range)),
      repo.paidOrderAggregate(ctx.db, { ...range, bucket: range.bucket }),
      repo.refundAggregate(ctx.db, { ...range, bucket: range.bucket }),
      repo.paidByHourOfDay(ctx.db, range),
      repo.paidByTopCategory(ctx.db, range),
      repo.platformBreakdown(ctx.db, range),
      repo.kindBreakdown(ctx.db, range),
    ]);
    const figures = { current, previous, yearAgo };

    const paidByBucket = align(range, paidSeries, (row) => row.paidAmount);
    const refundByBucket = align(range, refundSeries, (row) => row.refundAmount);
    const byHour = new Map(hours.map((row) => [row.hour, row]));

    return {
      ...envelope(ctx, range),
      metrics: [
        salesMetric('revenue', '营业额', 'money', revenueOf, figures),
        salesMetric('goodsPaidAmount', '商品支付金额', 'money', (f) => f.goodsAmount, figures),
        salesMetric('paidOrderCount', '支付订单数', 'count', (f) => f.orderCount, figures),
        salesMetric('averageOrderValue', '客单价', 'money', averageOrderValueOf, figures),
        salesMetric('paidQuantity', '支付件数', 'count', (f) => f.goodsQuantity, figures),
        salesMetric('refundAmount', '退款金额', 'money', (f) => f.refundAmount, figures),
        salesMetric('refundRate', '退款率', 'percent', refundRateOf, figures),
      ],
      chart: chart(range, [
        series(
          '营业额',
          'money',
          'line',
          paidByBucket.map((paid, index) => paid - (refundByBucket[index] ?? 0)),
        ),
        series(
          '支付订单数',
          'count',
          'bar',
          align(range, paidSeries, (row) => row.orderCount),
        ),
      ]),
      hourly: {
        bucket: 'hour',
        buckets: HOURS.map((hour) => String(hour).padStart(2, '0')),
        series: [
          series(
            '支付订单数',
            'count',
            'bar',
            HOURS.map((hour) => byHour.get(hour)?.orderCount ?? 0),
          ),
          series(
            '支付金额',
            'money',
            'line',
            HOURS.map((hour) => byHour.get(hour)?.paidAmount ?? 0),
          ),
        ],
      },
      categories: categoryRows(categories, current.goodsAmount),
      breakdowns: orderBreakdowns(platforms, kinds),
    };
  });
}

// ---------------------------------------------------------------------------
// 用户统计
// ---------------------------------------------------------------------------

interface UserFigures {
  visitors: number;
  pageViews: number;
  /** Whole seconds. */
  avgStaySeconds: number;
  newUsers: number;
  payingUsers: number;
}

async function userFigures(ctx: Ctx, window: Window): Promise<UserFigures> {
  const [visits, registrations, paid] = await Promise.all([
    repo.visitAggregate(ctx.db, { ...window, bucket: 'window' }),
    repo.registrationAggregate(ctx.db, { ...window, bucket: 'window' }),
    repo.paidOrderAggregate(ctx.db, { ...window, bucket: 'window' }),
  ]);
  return {
    visitors: only(visits, ZERO_VISITS).visitors,
    pageViews: only(visits, ZERO_VISITS).pageViews,
    avgStaySeconds: Math.round(Number(only(visits, ZERO_VISITS).avgStayMs) / 1000),
    newUsers: only(registrations, { newUsers: 0 }).newUsers,
    payingUsers: only(paid, ZERO_ORDERS).payingUsers,
  };
}

export async function userStats(ctx: Ctx, input: StatsRangeQuery): Promise<UserStats> {
  const range = resolveRange(input, ctx.clock);
  return cached(ctx, `users:${rangeKey(range)}`, async () => {
    const [current, previous, totalUsers, visitSeries, registrationSeries, paidSeries, platforms] =
      await Promise.all([
        userFigures(ctx, range),
        userFigures(ctx, range.previous),
        repo.totalUsersAt(ctx.db, range.to),
        repo.visitAggregate(ctx.db, { ...range, bucket: range.bucket }),
        repo.registrationAggregate(ctx.db, { ...range, bucket: range.bucket }),
        repo.paidOrderAggregate(ctx.db, { ...range, bucket: range.bucket }),
        repo.platformBreakdown(ctx.db, range),
      ]);

    return {
      ...envelope(ctx, range),
      metrics: [
        metric('visitors', '访客数', 'count', current.visitors, previous.visitors),
        metric('pageViews', '浏览量', 'count', current.pageViews, previous.pageViews),
        metric(
          'avgStay',
          '平均停留时长',
          'duration',
          current.avgStaySeconds,
          previous.avgStaySeconds,
        ),
        metric('newUsers', '新增用户', 'count', current.newUsers, previous.newUsers),
        metric('payingUsers', '成交用户数', 'count', current.payingUsers, previous.payingUsers),
        // A running total has nothing to compare against: "累计用户 vs the
        // previous window" would be the same number minus the new users.
        metric('totalUsers', '累计用户', 'count', totalUsers, null),
      ],
      chart: chart(range, [
        series(
          '新增用户',
          'count',
          'line',
          align(range, registrationSeries, (row) => row.newUsers),
        ),
        series(
          '访客数',
          'count',
          'line',
          align(range, visitSeries, (row) => row.visitors),
        ),
        series(
          '浏览量',
          'count',
          'line',
          align(range, visitSeries, (row) => row.pageViews),
        ),
        series(
          '成交用户数',
          'count',
          'line',
          align(range, paidSeries, (row) => row.payingUsers),
        ),
      ]),
      breakdowns: [
        breakdown(
          'platform',
          '下单来源',
          'count',
          PLATFORM_LABELS,
          platforms.map((row) => ({ key: row.platform, value: row.orderCount })),
        ),
      ],
    };
  });
}

export async function userRegions(ctx: Ctx, input: UserRegionQuery): Promise<UserRegionStats> {
  const range = resolveRange(input, ctx.clock);
  const key = `regions:${rangeKey(range)}:${input.sortBy}:${input.limit}`;
  return cached(ctx, key, async () => {
    const rows = await repo.regionRows(ctx.db, {
      from: range.from,
      to: range.to,
      sortBy: input.sortBy,
      limit: input.limit,
    });
    return {
      rows: rows.map((row) => ({
        province: row.province,
        totalUsers: row.totalUsers,
        newUsers: row.newUsers,
        visitors: row.visitors,
        paidAmount: round2(row.paidAmount),
      })),
      generatedAt: ctx.clock.now().toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// 商品统计
// ---------------------------------------------------------------------------

interface ProductFigures {
  views: number;
  viewers: number;
  cartQuantity: number;
  orderQuantity: number;
  paidQuantity: number;
  goodsAmount: number;
  payingUsers: number;
  refundQuantity: number;
  refundAmount: number;
}

async function productFigures(ctx: Ctx, window: Window): Promise<ProductFigures> {
  const [events, placed, paidLines, paidOrders, refunded, refundLines] = await Promise.all([
    repo.productEventAggregate(ctx.db, { ...window, bucket: 'window' }),
    repo.placedGoodsAggregate(ctx.db, { ...window, bucket: 'window' }),
    repo.paidGoodsAggregate(ctx.db, { ...window, bucket: 'window' }),
    repo.paidOrderAggregate(ctx.db, { ...window, bucket: 'window' }),
    repo.refundAggregate(ctx.db, { ...window, bucket: 'window' }),
    repo.refundQuantityAggregate(ctx.db, { ...window, bucket: 'window' }),
  ]);
  const traffic = only(events, ZERO_EVENTS);
  return {
    views: traffic.views,
    viewers: traffic.viewers,
    cartQuantity: traffic.cartQuantity,
    orderQuantity: only(placed, ZERO_PLACED).quantity,
    paidQuantity: only(paidLines, ZERO_GOODS).quantity,
    goodsAmount: only(paidLines, ZERO_GOODS).goodsAmount,
    payingUsers: only(paidOrders, ZERO_ORDERS).payingUsers,
    refundQuantity: only(refundLines, ZERO_QUANTITY).quantity,
    refundAmount: only(refunded, ZERO_REFUNDS).refundAmount,
  };
}

/** 访问-支付转化率: paying users over product visitors, both distinct counts. */
const conversionOf = (figures: { payingUsers: number; viewers: number }): number =>
  figures.viewers === 0 ? 0 : percent(figures.payingUsers, figures.viewers);

export async function productStats(ctx: Ctx, input: StatsRangeQuery): Promise<ProductStats> {
  const range = resolveRange(input, ctx.clock);
  return cached(ctx, `products:${rangeKey(range)}`, async () => {
    const [current, previous, eventSeries, goodsSeries, refundSeries] = await Promise.all([
      productFigures(ctx, range),
      productFigures(ctx, range.previous),
      repo.productEventAggregate(ctx.db, { ...range, bucket: range.bucket }),
      repo.paidGoodsAggregate(ctx.db, { ...range, bucket: range.bucket }),
      repo.refundAggregate(ctx.db, { ...range, bucket: range.bucket }),
    ]);

    return {
      ...envelope(ctx, range),
      metrics: [
        metric('productViews', '商品浏览量', 'count', current.views, previous.views),
        metric('productVisitors', '商品访客数', 'count', current.viewers, previous.viewers),
        metric('cartQuantity', '加购件数', 'count', current.cartQuantity, previous.cartQuantity),
        metric('orderQuantity', '下单件数', 'count', current.orderQuantity, previous.orderQuantity),
        metric('paidQuantity', '支付件数', 'count', current.paidQuantity, previous.paidQuantity),
        metric('paidAmount', '支付金额', 'money', current.goodsAmount, previous.goodsAmount),
        metric(
          'refundQuantity',
          '退款件数',
          'count',
          current.refundQuantity,
          previous.refundQuantity,
        ),
        metric('refundAmount', '退款金额', 'money', current.refundAmount, previous.refundAmount),
        metric(
          'payConversion',
          '访问-支付转化率',
          'percent',
          conversionOf(current),
          conversionOf(previous),
        ),
      ],
      chart: chart(range, [
        series(
          '商品浏览量',
          'count',
          'line',
          align(range, eventSeries, (row) => row.views),
        ),
        series(
          '商品访客数',
          'count',
          'line',
          align(range, eventSeries, (row) => row.viewers),
        ),
        series(
          '支付金额',
          'money',
          'bar',
          align(range, goodsSeries, (row) => row.goodsAmount),
        ),
        series(
          '退款金额',
          'money',
          'bar',
          align(range, refundSeries, (row) => row.refundAmount),
        ),
      ]),
    };
  });
}

export async function productRanking(
  ctx: Ctx,
  input: ProductRankingQuery,
): Promise<ProductRanking> {
  const range = resolveRange(input, ctx.clock);
  const key = `ranking:${rangeKey(range)}:${input.sortBy}:${input.limit}`;
  return cached(ctx, key, async () => {
    const rows = await rankingRows(ctx, range, input.sortBy, input.limit);
    return { rows, generatedAt: ctx.clock.now().toISOString() };
  });
}

async function rankingRows(
  ctx: Ctx,
  range: ResolvedRange,
  sortBy: repo.RankingSortKey,
  limit: number,
): Promise<ProductRanking['rows']> {
  const rows = await repo.productRankingRows(ctx.db, {
    from: range.from,
    to: range.to,
    sortBy,
    limit,
  });
  return rows.map((row) => ({
    productId: toId(row.productId),
    name: row.name,
    imageUrl: row.imageUrl,
    views: row.views,
    visitors: row.visitors,
    cartQuantity: row.cartQuantity,
    orderQuantity: row.orderQuantity,
    paidQuantity: row.paidQuantity,
    paidAmount: round2(row.paidAmount),
    favorites: row.favorites,
    conversion: conversionOf({ payingUsers: row.payingVisitors, viewers: row.visitors }),
  }));
}

// ---------------------------------------------------------------------------
// exports — CSV inside a JSON envelope
// ---------------------------------------------------------------------------

/**
 * One CSV cell.
 *
 * Quoted whenever it contains a separator, a quote or a newline — product
 * names contain all three — and a text cell with a leading `=`, `+`, `-` or
 * `@` is prefixed with a `'` so a spreadsheet treats it as text. A product
 * called `=1+1` is a formula injection in every CSV reader that follows Excel.
 * Numbers are ours and are left alone: a guarded `-95.00` would not sum.
 */
function cell(value: string | number): string {
  if (typeof value === 'number') return value.toFixed(2);
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function csv(header: string[], rows: Array<Array<string | number>>): string {
  return [header.join(','), ...rows.map((row) => row.map(cell).join(','))].join('\n') + '\n';
}

/**
 * 交易统计导出 — one row per bucket.
 *
 * A time series is refused rather than truncated when it does not fit the cap:
 * dropping the tail of a series hands the operator a file that looks like a
 * complete window and is not. A ranking (below) is a different matter — its
 * rows are ordered by importance, so the first `n` of them is a truthful
 * answer to "the top sellers", and that one is flagged `truncated` instead.
 */
export async function tradeExport(ctx: Ctx, input: StatsRangeQuery): Promise<StatsExportResult> {
  const range = resolveRange(input, ctx.clock);
  const { exportMaxRows } = await ctx.config.get(statsConfig);
  if (range.bucketStarts.length > exportMaxRows) {
    throw new DomainError('STATS_EXPORT_TOO_LARGE', {
      details: { maxRows: exportMaxRows, matched: range.bucketStarts.length },
    });
  }

  const [paidSeries, goodsSeries, refundSeries] = await Promise.all([
    repo.paidOrderAggregate(ctx.db, { ...range, bucket: range.bucket }),
    repo.paidGoodsAggregate(ctx.db, { ...range, bucket: range.bucket }),
    repo.refundAggregate(ctx.db, { ...range, bucket: range.bucket }),
  ]);

  const paid = align(range, paidSeries, (row) => row.paidAmount);
  const counts = align(range, paidSeries, (row) => row.orderCount);
  const freight = align(range, paidSeries, (row) => row.freightAmount);
  const goods = align(range, goodsSeries, (row) => row.goodsAmount);
  const refunded = align(range, refundSeries, (row) => row.refundAmount);

  const rows = range.buckets.map((label, index) => [
    label,
    (paid[index] ?? 0) - (refunded[index] ?? 0),
    goods[index] ?? 0,
    refunded[index] ?? 0,
    freight[index] ?? 0,
    String(counts[index] ?? 0),
  ]);

  return {
    filename: statsExportFilename('交易统计', range),
    contentType: 'text/csv',
    rowCount: rows.length,
    truncated: false,
    content: csv(
      ['日期', '营业额', '商品支付金额', '商品退款金额', '运费收入', '支付订单数'],
      rows,
    ),
  };
}

/**
 * 商品统计导出 — the ranking, as far down as the cap allows.
 *
 * `limit` is deliberately ignored here: it sizes the table on screen, and an
 * operator exporting a file wants the window's products, not the twenty rows
 * they can already see. The cap is `stats.exportMaxRows`.
 */
export async function productExport(
  ctx: Ctx,
  input: ProductRankingQuery,
): Promise<StatsExportResult> {
  const range = resolveRange(input, ctx.clock);
  const { exportMaxRows } = await ctx.config.get(statsConfig);

  const [rows, matched] = await Promise.all([
    rankingRows(ctx, range, input.sortBy, exportMaxRows),
    repo.productRankingCount(ctx.db, { from: range.from, to: range.to }),
  ]);

  return {
    filename: statsExportFilename('商品统计', range),
    contentType: 'text/csv',
    rowCount: rows.length,
    truncated: matched > rows.length,
    content: csv(
      [
        '商品ID',
        '商品名称',
        '浏览量',
        '访客数',
        '加购件数',
        '下单件数',
        '支付件数',
        '支付金额',
        '收藏数',
        '访问-支付转化率',
      ],
      rows.map((row) => [
        row.productId,
        row.name,
        String(row.views),
        String(row.visitors),
        String(row.cartQuantity),
        String(row.orderQuantity),
        String(row.paidQuantity),
        row.paidAmount,
        String(row.favorites),
        row.conversion,
      ]),
    ),
  };
}

/**
 * 分类销售导出 — the 销售看板's category table, one row per top-level category.
 *
 * Refused rather than cut off above the cap, like 交易统计: the rows are the
 * whole window's split, and a file missing some of them reads as complete.
 */
export async function salesExport(ctx: Ctx, input: StatsRangeQuery): Promise<StatsExportResult> {
  const range = resolveRange(input, ctx.clock);
  const { exportMaxRows } = await ctx.config.get(statsConfig);

  const [current, categories] = await Promise.all([
    tradeFigures(ctx, range),
    repo.paidByTopCategory(ctx.db, range),
  ]);
  if (categories.length > exportMaxRows) {
    throw new DomainError('STATS_EXPORT_TOO_LARGE', {
      details: { maxRows: exportMaxRows, matched: categories.length },
    });
  }
  const rows = categoryRows(categories, current.goodsAmount);

  return {
    filename: statsExportFilename('分类销售', range),
    contentType: 'text/csv',
    rowCount: rows.length,
    truncated: false,
    content: csv(
      ['分类', '支付金额', '支付件数', '支付订单数', '占比(%)'],
      rows.map((row) => [
        row.name,
        row.paidAmount,
        String(row.paidQuantity),
        String(row.orderCount),
        row.percent,
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// what the admin home page borrows
// ---------------------------------------------------------------------------

export interface TodayFigures {
  revenue: number;
  paidOrderCount: number;
  newUsers: number;
  previous: { revenue: number; paidOrderCount: number; newUsers: number };
}

/**
 * Today and yesterday, in Shanghai days, for the dashboard tiles.
 *
 * Its own function rather than a call to `tradeStats`: the home page needs six
 * numbers, not two pages of charts, and it has a three-second budget before
 * the contributor is dropped from the header.
 */
export async function todayFigures(ctx: Ctx): Promise<TodayFigures> {
  const range = resolveRange({}, ctx.clock);
  const today = { from: new Date(range.to.getTime() - 86_400_000), to: range.to };
  const yesterday = { from: new Date(today.from.getTime() - 86_400_000), to: today.from };

  const [current, before, registrations, registrationsBefore] = await Promise.all([
    tradeFigures(ctx, today),
    tradeFigures(ctx, yesterday),
    repo.registrationAggregate(ctx.db, { ...today, bucket: 'window' }),
    repo.registrationAggregate(ctx.db, { ...yesterday, bucket: 'window' }),
  ]);

  return {
    revenue: round2(revenueOf(current)),
    paidOrderCount: current.orderCount,
    newUsers: only(registrations, { newUsers: 0 }).newUsers,
    previous: {
      revenue: round2(revenueOf(before)),
      paidOrderCount: before.orderCount,
      newUsers: only(registrationsBefore, { newUsers: 0 }).newUsers,
    },
  };
}
