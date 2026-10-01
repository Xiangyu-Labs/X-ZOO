import { z } from 'zod';
import { id, instant } from '../_conventions/common';

/**
 * Operator statistics.
 *
 * ## Why every figure is a plain `number`
 *
 * `docs/conventions.md` says money is a `"12.00"` string, and it is right — for
 * money that somebody is going to be charged. These are *display aggregates*:
 * sums produced by PostgreSQL, rounded to two decimals, read by a human and
 * drawn as a chart. None of them ever reaches a payment, a refund or a ledger.
 * The system domain's `dashboardTile` already carries a money figure as a
 * number with a `format` discriminator, and one shape for both dashboards is
 * worth more here than a rule aimed at transactional money. A yuan amount up to
 * ten digits is exact in a double, so nothing is lost on the way out.
 *
 * ## Why every figure has one definition
 *
 * If each page computed "revenue" its own way — by payment time or creation
 * time, with or without refunded orders — three screens would show three
 * different numbers for the same day. Every figure here is defined once, in
 * `packages/core/src/stats/DEFINITIONS.md`, and every page reads the same
 * definition.
 */

// ---------------------------------------------------------------------------
// the shared vocabulary
// ---------------------------------------------------------------------------

/** `duration` is a number of seconds, written as 分 / 秒 by the page. */
export const statsFormat = z.enum(['count', 'money', 'percent', 'duration']);
export type StatsFormat = z.infer<typeof statsFormat>;

/** How the window was cut up. Derived from its length; see `statsRangeQuery`. */
export const statsBucket = z.enum(['hour', 'day', 'month']);
export type StatsBucket = z.infer<typeof statsBucket>;

/**
 * One headline number, with the same figure over the window immediately before
 * this one so the page can draw 环比. `previous` is `null` when the preceding
 * window would start before the shop existed, or when a comparison is
 * meaningless (a running total).
 */
export const statsMetric = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  format: statsFormat,
  previous: z.number().nullable(),
});
export type StatsMetric = z.infer<typeof statsMetric>;

export const statsSeries = z.object({
  name: z.string(),
  format: statsFormat,
  /** `line` or `bar`; the page may override, but this is the shape the figure wants. */
  shape: z.enum(['line', 'bar']),
  /** Same length and order as `buckets`. */
  values: z.array(z.number()),
});
export type StatsSeries = z.infer<typeof statsSeries>;

export const statsChart = z.object({
  bucket: statsBucket,
  /** Bucket labels: `09` for an hour, `2026-02-03` for a day, `2026-02` for a month. */
  buckets: z.array(z.string()),
  series: z.array(statsSeries),
});
export type StatsChart = z.infer<typeof statsChart>;

/** A pie / table breakdown: 来源, 订单类型, 性别. `percent` is 0–100, two decimals. */
export const statsBreakdownRow = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  percent: z.number(),
});

export const statsBreakdown = z.object({
  key: z.string(),
  label: z.string(),
  format: statsFormat,
  rows: z.array(statsBreakdownRow),
});
export type StatsBreakdown = z.infer<typeof statsBreakdown>;

/**
 * The window.
 *
 * Both ends are instants because that is what the admin kit's `dateRange`
 * filter sends; the service immediately turns them into **Asia/Shanghai
 * calendar days** and every bucket boundary is a Shanghai midnight. Omitting
 * them means the last 30 days ending today.
 *
 * The bucket is derived, not chosen: up to 2 days → `hour`, up to 92 days →
 * `day`, beyond that → `month`. A caller-chosen bucket invites a long window
 * drawn daily with most of its labels dropped.
 */
export const statsRangeQuery = z.object({
  from: instant.optional(),
  to: instant.optional(),
});
export type StatsRangeQuery = z.infer<typeof statsRangeQuery>;

/** What every page answers with: the window it actually used, plus tiles and a chart. */
const statsPage = z.object({
  /** Start of the first Shanghai day in the window. */
  from: instant,
  /** End of the last Shanghai day in the window, exclusive. */
  to: instant,
  metrics: z.array(statsMetric),
  chart: statsChart,
  /** From `ctx.clock`. The block is cached for 60 seconds, so this may lag. */
  generatedAt: instant,
});

/** CSV in a JSON envelope, exactly like the order export. */
export const statsExportResult = z.object({
  filename: z.string(),
  contentType: z.literal('text/csv'),
  rowCount: z.number().int().min(0),
  truncated: z.boolean(),
  /** UTF-8 CSV, header row included. The client prepends a BOM for Excel. */
  content: z.string(),
});
export type StatsExportResult = z.infer<typeof statsExportResult>;

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const userStats = statsPage.extend({
  breakdowns: z.array(statsBreakdown),
});
export type UserStats = z.infer<typeof userStats>;

export const userRegionRow = z.object({
  province: z.string(),
  totalUsers: z.number().int().min(0),
  newUsers: z.number().int().min(0),
  visitors: z.number().int().min(0),
  paidAmount: z.number(),
});
export const userRegionStats = z.object({
  rows: z.array(userRegionRow),
  generatedAt: instant,
});
export type UserRegionStats = z.infer<typeof userRegionStats>;

export const userRegionQuery = statsRangeQuery.extend({
  sortBy: z.enum(['totalUsers', 'newUsers', 'visitors', 'paidAmount']).default('totalUsers'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type UserRegionQuery = z.infer<typeof userRegionQuery>;

// ---------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------

export const productStats = statsPage;
export type ProductStats = z.infer<typeof productStats>;

export const productRankingSort = z.enum([
  'views',
  'visitors',
  'cartQuantity',
  'orderQuantity',
  'paidQuantity',
  'paidAmount',
  'favorites',
]);
export type ProductRankingSort = z.infer<typeof productRankingSort>;

export const productRankingRow = z.object({
  productId: id,
  name: z.string(),
  imageUrl: z.string().nullable(),
  views: z.number().int().min(0),
  visitors: z.number().int().min(0),
  cartQuantity: z.number().int().min(0),
  orderQuantity: z.number().int().min(0),
  paidQuantity: z.number().int().min(0),
  paidAmount: z.number(),
  favorites: z.number().int().min(0),
  /** Paying visitors ÷ visitors, 0–100 with two decimals. `0` when nobody visited. */
  conversion: z.number(),
});
export type ProductRankingRow = z.infer<typeof productRankingRow>;

export const productRanking = z.object({
  rows: z.array(productRankingRow),
  generatedAt: instant,
});
export type ProductRanking = z.infer<typeof productRanking>;

export const productRankingQuery = statsRangeQuery.extend({
  sortBy: productRankingSort.default('paidAmount'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ProductRankingQuery = z.infer<typeof productRankingQuery>;

// ---------------------------------------------------------------------------
// trade and orders
// ---------------------------------------------------------------------------

export const tradeStats = statsPage;
export type TradeStats = z.infer<typeof tradeStats>;

export const orderStats = statsPage.extend({
  breakdowns: z.array(statsBreakdown),
});
export type OrderStats = z.infer<typeof orderStats>;

// ---------------------------------------------------------------------------
// sales — 销售看板
// ---------------------------------------------------------------------------

/**
 * A headline figure with 同比 on top of 环比: `yearAgo` is the same figure
 * over the same Shanghai calendar days one year earlier.
 */
export const salesMetric = statsMetric.extend({
  yearAgo: z.number().nullable(),
});
export type SalesMetric = z.infer<typeof salesMetric>;

/**
 * One top-level category's share of the window's 商品支付金额. `categoryId`
 * is `null` for 未分类. A product in two top-level categories counts in both,
 * so `percent` across rows can add up to more than 100.
 */
export const salesCategoryRow = z.object({
  categoryId: id.nullable(),
  name: z.string(),
  paidAmount: z.number(),
  paidQuantity: z.number().int().min(0),
  orderCount: z.number().int().min(0),
  /** `paidAmount ÷ 商品支付金额 × 100`, two decimals. */
  percent: z.number(),
});
export type SalesCategoryRow = z.infer<typeof salesCategoryRow>;

export const salesStats = statsPage.extend({
  metrics: z.array(salesMetric),
  /** Paid orders by Shanghai hour of day, `00`…`23`, summed over every day of the window. */
  hourly: statsChart,
  categories: z.array(salesCategoryRow),
  breakdowns: z.array(statsBreakdown),
});
export type SalesStats = z.infer<typeof salesStats>;

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

const WINDOW = {
  from: '2026-02-01T00:00:00+08:00',
  to: '2026-02-04T00:00:00+08:00',
  generatedAt: '2026-02-04T10:00:00+08:00',
};

const dayBuckets = ['2026-02-01', '2026-02-02', '2026-02-03'];

export const userStatsExample: UserStats = {
  ...WINDOW,
  metrics: [
    { key: 'visitors', label: '访客数', value: 1820, format: 'count', previous: 1640 },
    { key: 'pageViews', label: '浏览量', value: 7431, format: 'count', previous: 6900 },
    { key: 'avgStay', label: '平均停留时长', value: 65, format: 'duration', previous: 58 },
    { key: 'newUsers', label: '新增用户', value: 96, format: 'count', previous: 104 },
    { key: 'payingUsers', label: '成交用户数', value: 212, format: 'count', previous: 198 },
    { key: 'totalUsers', label: '累计用户', value: 18422, format: 'count', previous: null },
  ],
  chart: {
    bucket: 'day',
    buckets: dayBuckets,
    series: [
      { name: '新增用户', format: 'count', shape: 'line', values: [30, 32, 34] },
      { name: '访客数', format: 'count', shape: 'line', values: [600, 610, 610] },
      { name: '浏览量', format: 'count', shape: 'line', values: [2400, 2500, 2531] },
      { name: '成交用户数', format: 'count', shape: 'line', values: [70, 71, 71] },
    ],
  },
  breakdowns: [
    {
      key: 'platform',
      label: '下单来源',
      format: 'count',
      rows: [
        { key: 'wechat_mini', label: '小程序', value: 140, percent: 66.04 },
        { key: 'h5', label: 'H5', value: 52, percent: 24.53 },
        { key: 'wechat_oa', label: '公众号', value: 20, percent: 9.43 },
      ],
    },
  ],
};

export const userRegionStatsExample: UserRegionStats = {
  rows: [
    { province: '广东', totalUsers: 3120, newUsers: 22, visitors: 410, paidAmount: 48210.5 },
    { province: '浙江', totalUsers: 2044, newUsers: 15, visitors: 288, paidAmount: 30122.0 },
  ],
  generatedAt: WINDOW.generatedAt,
};

export const productStatsExample: ProductStats = {
  ...WINDOW,
  metrics: [
    { key: 'productViews', label: '商品浏览量', value: 5120, format: 'count', previous: 4800 },
    { key: 'productVisitors', label: '商品访客数', value: 1402, format: 'count', previous: 1330 },
    { key: 'cartQuantity', label: '加购件数', value: 640, format: 'count', previous: 588 },
    { key: 'orderQuantity', label: '下单件数', value: 402, format: 'count', previous: 380 },
    { key: 'paidQuantity', label: '支付件数', value: 366, format: 'count', previous: 351 },
    { key: 'paidAmount', label: '支付金额', value: 82310.4, format: 'money', previous: 79204.1 },
    { key: 'refundQuantity', label: '退款件数', value: 12, format: 'count', previous: 9 },
    { key: 'refundAmount', label: '退款金额', value: 1820.0, format: 'money', previous: 1400.0 },
    {
      key: 'payConversion',
      label: '访问-支付转化率',
      value: 15.12,
      format: 'percent',
      previous: 14.4,
    },
  ],
  chart: {
    bucket: 'day',
    buckets: dayBuckets,
    series: [
      { name: '商品浏览量', format: 'count', shape: 'line', values: [1700, 1710, 1710] },
      { name: '商品访客数', format: 'count', shape: 'line', values: [467, 467, 468] },
      { name: '支付金额', format: 'money', shape: 'bar', values: [27000.1, 27500.2, 27810.1] },
      { name: '退款金额', format: 'money', shape: 'bar', values: [600.0, 620.0, 600.0] },
    ],
  },
};

export const productRankingExample: ProductRanking = {
  rows: [
    {
      productId: '77',
      name: '云南小粒咖啡豆 500g',
      imageUrl: '/uploads/2026/01/coffee.png',
      views: 1820,
      visitors: 640,
      cartQuantity: 180,
      orderQuantity: 120,
      paidQuantity: 112,
      paidAmount: 7728.0,
      favorites: 44,
      conversion: 17.5,
    },
  ],
  generatedAt: WINDOW.generatedAt,
};

export const tradeStatsExample: TradeStats = {
  ...WINDOW,
  metrics: [
    { key: 'revenue', label: '营业额', value: 80490.4, format: 'money', previous: 77804.1 },
    {
      key: 'goodsPaidAmount',
      label: '商品支付金额',
      value: 82310.4,
      format: 'money',
      previous: 79204.1,
    },
    {
      key: 'refundAmount',
      label: '商品退款金额',
      value: 1820.0,
      format: 'money',
      previous: 1400.0,
    },
    { key: 'freightAmount', label: '运费收入', value: 1240.0, format: 'money', previous: 1180.0 },
    { key: 'paidOrderCount', label: '支付订单数', value: 318, format: 'count', previous: 302 },
    { key: 'averageOrderValue', label: '客单价', value: 258.84, format: 'money', previous: 262.26 },
  ],
  chart: {
    bucket: 'day',
    buckets: dayBuckets,
    series: [
      { name: '营业额', format: 'money', shape: 'line', values: [26400.1, 26880.2, 27210.1] },
      { name: '商品支付金额', format: 'money', shape: 'line', values: [27000.1, 27500.2, 27810.1] },
      { name: '商品退款金额', format: 'money', shape: 'line', values: [600.0, 620.0, 600.0] },
    ],
  },
};

export const orderStatsExample: OrderStats = {
  ...WINDOW,
  metrics: [
    { key: 'paidOrderCount', label: '订单量', value: 318, format: 'count', previous: 302 },
    { key: 'paidAmount', label: '订单销售额', value: 82310.4, format: 'money', previous: 79204.1 },
    { key: 'refundOrderCount', label: '退款订单数', value: 9, format: 'count', previous: 7 },
    { key: 'refundAmount', label: '退款金额', value: 1820.0, format: 'money', previous: 1400.0 },
    { key: 'refundRate', label: '退款率', value: 2.83, format: 'percent', previous: 2.32 },
  ],
  chart: {
    bucket: 'day',
    buckets: dayBuckets,
    series: [
      { name: '订单金额', format: 'money', shape: 'line', values: [27000.1, 27500.2, 27810.1] },
      { name: '订单量', format: 'count', shape: 'line', values: [104, 106, 108] },
      { name: '退款金额', format: 'money', shape: 'line', values: [600.0, 620.0, 600.0] },
      { name: '退款订单量', format: 'count', shape: 'line', values: [3, 3, 3] },
    ],
  },
  breakdowns: [
    {
      key: 'platform',
      label: '订单来源',
      format: 'count',
      rows: [
        { key: 'wechat_mini', label: '小程序', value: 210, percent: 66.04 },
        { key: 'h5', label: 'H5', value: 78, percent: 24.53 },
        { key: 'wechat_oa', label: '公众号', value: 30, percent: 9.43 },
      ],
    },
    {
      key: 'kind',
      label: '订单类型',
      format: 'money',
      rows: [
        { key: 'normal', label: '普通订单', value: 70210.4, percent: 85.3 },
        { key: 'groupbuy', label: '拼团订单', value: 8100.0, percent: 9.84 },
        { key: 'presale', label: '预售订单', value: 4000.0, percent: 4.86 },
      ],
    },
  ],
};

export const statsExportExample: StatsExportResult = {
  filename: '交易统计-2026-02-01至2026-02-03.csv',
  contentType: 'text/csv',
  rowCount: 3,
  truncated: false,
  content:
    '日期,营业额,商品支付金额,商品退款金额,运费收入,支付订单数\n' +
    '2026-02-01,26400.10,27000.10,600.00,410.00,104\n' +
    '2026-02-02,26880.20,27500.20,620.00,415.00,106\n' +
    '2026-02-03,27210.10,27810.10,600.00,415.00,108\n',
};

const hourBuckets = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));

export const salesStatsExample: SalesStats = {
  ...WINDOW,
  metrics: [
    {
      key: 'revenue',
      label: '营业额',
      value: 80490.4,
      format: 'money',
      previous: 77804.1,
      yearAgo: 61200.0,
    },
    {
      key: 'goodsPaidAmount',
      label: '商品支付金额',
      value: 82310.4,
      format: 'money',
      previous: 79204.1,
      yearAgo: 62800.0,
    },
    {
      key: 'paidOrderCount',
      label: '支付订单数',
      value: 318,
      format: 'count',
      previous: 302,
      yearAgo: 240,
    },
    {
      key: 'averageOrderValue',
      label: '客单价',
      value: 253.11,
      format: 'money',
      previous: 257.63,
      yearAgo: 255.0,
    },
    {
      key: 'paidQuantity',
      label: '支付件数',
      value: 366,
      format: 'count',
      previous: 351,
      yearAgo: 280,
    },
    {
      key: 'refundAmount',
      label: '退款金额',
      value: 1820.0,
      format: 'money',
      previous: 1400.0,
      yearAgo: 1600.0,
    },
    {
      key: 'refundRate',
      label: '退款率',
      value: 2.83,
      format: 'percent',
      previous: 2.32,
      yearAgo: 3.33,
    },
  ],
  chart: {
    bucket: 'day',
    buckets: dayBuckets,
    series: [
      { name: '营业额', format: 'money', shape: 'line', values: [26400.1, 26880.2, 27210.1] },
      { name: '支付订单数', format: 'count', shape: 'bar', values: [104, 106, 108] },
    ],
  },
  hourly: {
    bucket: 'hour',
    buckets: hourBuckets,
    series: [
      {
        name: '支付订单数',
        format: 'count',
        shape: 'bar',
        values: [
          2, 1, 0, 0, 0, 0, 1, 3, 8, 14, 20, 24, 26, 18, 16, 17, 19, 21, 25, 30, 32, 22, 12, 7,
        ],
      },
      {
        name: '支付金额',
        format: 'money',
        shape: 'line',
        values: [
          520.0, 260.0, 0, 0, 0, 0, 258.0, 776.0, 2070.4, 3624.0, 5178.0, 6214.0, 6732.0, 4660.0,
          4142.0, 4400.0, 4918.0, 5436.0, 6472.0, 7766.0, 8284.0, 5696.0, 3106.0, 1798.0,
        ],
      },
    ],
  },
  categories: [
    {
      categoryId: '3',
      name: '咖啡',
      paidAmount: 52310.4,
      paidQuantity: 220,
      orderCount: 196,
      percent: 63.55,
    },
    {
      categoryId: '8',
      name: '茶饮',
      paidAmount: 30000.0,
      paidQuantity: 146,
      orderCount: 130,
      percent: 36.45,
    },
  ],
  breakdowns: orderStatsExample.breakdowns,
};

export const salesExportExample: StatsExportResult = {
  filename: '分类销售-2026-02-01至2026-02-03.csv',
  contentType: 'text/csv',
  rowCount: 2,
  truncated: false,
  content:
    '分类,支付金额,支付件数,支付订单数,占比(%)\n' +
    '咖啡,52310.40,220,196,63.55\n' +
    '茶饮,30000.00,146,130,36.45\n',
};
