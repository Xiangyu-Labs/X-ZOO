import { defineRoute } from '../_conventions/route';
import {
  orderStats,
  orderStatsExample,
  productRanking,
  productRankingExample,
  productRankingQuery,
  productStats,
  productStatsExample,
  salesExportExample,
  salesStats,
  salesStatsExample,
  statsExportExample,
  statsExportResult,
  statsRangeQuery,
  tradeStats,
  tradeStatsExample,
  userRegionQuery,
  userRegionStats,
  userRegionStatsExample,
  userStats,
  userStatsExample,
} from './schemas';

/**
 * 统计, `/admin-api/stats/*`. Ten read-only routes, no writes anywhere.
 *
 * What is deliberately absent:
 *
 * - **No 资金流水 / 账单记录 / 余额统计.** Those are balance and recharge
 *   ledgers, and balance, recharge, commission, points and paid membership are
 *   not part of the shop.
 * - **The admin home page has no statistics routes of its own.** Its tiles come
 *   from the system domain's `GET /admin-api/system/dashboard/header`, which
 *   this domain feeds through `registerDashboardContributor`, and its two
 *   charts and its product ranking are `stats/orders`, `stats/users` and
 *   `stats/products/ranking` with a range — so the home page and the statistics
 *   pages can never disagree about a figure.
 */

export const statsUsers = defineRoute({
  id: 'stats.users',
  method: 'GET',
  path: '/admin-api/stats/users',
  auth: 'admin',
  permission: 'stats:user:read',
  summary: '用户统计',
  tags: ['stats'],
  query: statsRangeQuery,
  response: userStats,
  errors: ['STATS_RANGE_INVALID'],
  examples: [
    {
      name: 'three-days',
      query: { from: '2026-02-01T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      response: userStatsExample,
    },
  ],
});

export const statsUserRegions = defineRoute({
  id: 'stats.userRegions',
  method: 'GET',
  path: '/admin-api/stats/users/regions',
  auth: 'admin',
  permission: 'stats:user:read',
  summary: '用户地域分布',
  tags: ['stats'],
  query: userRegionQuery,
  response: userRegionStats,
  errors: ['STATS_RANGE_INVALID'],
  examples: [
    {
      name: 'top-ten',
      query: { sortBy: 'totalUsers', limit: 10 },
      response: userRegionStatsExample,
    },
  ],
});

export const statsProducts = defineRoute({
  id: 'stats.products',
  method: 'GET',
  path: '/admin-api/stats/products',
  auth: 'admin',
  permission: 'stats:product:read',
  summary: '商品统计',
  tags: ['stats'],
  query: statsRangeQuery,
  response: productStats,
  errors: ['STATS_RANGE_INVALID'],
  examples: [
    {
      name: 'three-days',
      query: { from: '2026-02-01T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      response: productStatsExample,
    },
  ],
});

export const statsProductRanking = defineRoute({
  id: 'stats.productRanking',
  method: 'GET',
  path: '/admin-api/stats/products/ranking',
  auth: 'admin',
  permission: 'stats:product:read',
  summary: '商品排行',
  tags: ['stats'],
  query: productRankingQuery,
  response: productRanking,
  errors: ['STATS_RANGE_INVALID'],
  examples: [
    {
      name: 'by-amount',
      query: { sortBy: 'paidAmount', limit: 20 },
      response: productRankingExample,
    },
  ],
});

export const statsProductExport = defineRoute({
  id: 'stats.productExport',
  method: 'GET',
  path: '/admin-api/stats/products/exports',
  auth: 'admin',
  permission: 'stats:product:export',
  summary: '导出商品统计',
  tags: ['stats'],
  query: productRankingQuery,
  response: statsExportResult,
  errors: ['STATS_RANGE_INVALID', 'STATS_EXPORT_TOO_LARGE'],
  examples: [
    {
      name: 'ok',
      query: { sortBy: 'paidAmount', limit: 20 },
      response: {
        ...statsExportExample,
        filename: '商品统计-2026-02-01至2026-02-03.csv',
        rowCount: 1,
        content:
          '商品ID,商品名称,浏览量,访客数,加购件数,下单件数,支付件数,支付金额,收藏数,访问-支付转化率\n' +
          '77,云南小粒咖啡豆 500g,1820,640,180,120,112,7728.00,44,17.50\n',
      },
    },
  ],
});

export const statsTrade = defineRoute({
  id: 'stats.trade',
  method: 'GET',
  path: '/admin-api/stats/trade',
  auth: 'admin',
  permission: 'stats:trade:read',
  summary: '交易统计',
  tags: ['stats'],
  query: statsRangeQuery,
  response: tradeStats,
  errors: ['STATS_RANGE_INVALID'],
  examples: [
    {
      name: 'three-days',
      query: { from: '2026-02-01T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      response: tradeStatsExample,
    },
  ],
});

export const statsTradeExport = defineRoute({
  id: 'stats.tradeExport',
  method: 'GET',
  path: '/admin-api/stats/trade/exports',
  auth: 'admin',
  permission: 'stats:trade:export',
  summary: '导出交易统计',
  tags: ['stats'],
  query: statsRangeQuery,
  response: statsExportResult,
  errors: ['STATS_RANGE_INVALID', 'STATS_EXPORT_TOO_LARGE'],
  examples: [
    {
      name: 'ok',
      query: { from: '2026-02-01T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      response: statsExportExample,
    },
  ],
});

/**
 * 销售看板 — the sales figures of 交易统计 and 订单统计 on one screen, each
 * with 同比 as well as 环比, plus 时段分布 and 分类销售. The shared figures
 * are computed by the same queries as those pages, so the three agree.
 */
export const statsSales = defineRoute({
  id: 'stats.sales',
  method: 'GET',
  path: '/admin-api/stats/sales',
  auth: 'admin',
  permission: 'stats:sales:read',
  summary: '销售看板',
  tags: ['stats'],
  query: statsRangeQuery,
  response: salesStats,
  errors: ['STATS_RANGE_INVALID'],
  examples: [
    {
      name: 'three-days',
      query: { from: '2026-02-01T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      response: salesStatsExample,
    },
  ],
});

/** 分类销售, one row per top-level category. */
export const statsSalesExport = defineRoute({
  id: 'stats.salesExport',
  method: 'GET',
  path: '/admin-api/stats/sales/exports',
  auth: 'admin',
  permission: 'stats:sales:export',
  summary: '导出分类销售',
  tags: ['stats'],
  query: statsRangeQuery,
  response: statsExportResult,
  errors: ['STATS_RANGE_INVALID', 'STATS_EXPORT_TOO_LARGE'],
  examples: [
    {
      name: 'ok',
      query: { from: '2026-02-01T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      response: salesExportExample,
    },
  ],
});

export const statsOrders = defineRoute({
  id: 'stats.orders',
  method: 'GET',
  path: '/admin-api/stats/orders',
  auth: 'admin',
  permission: 'stats:order:read',
  summary: '订单统计',
  tags: ['stats'],
  query: statsRangeQuery,
  response: orderStats,
  errors: ['STATS_RANGE_INVALID'],
  examples: [
    {
      name: 'three-days',
      query: { from: '2026-02-01T00:00:00+08:00', to: '2026-02-03T23:59:59+08:00' },
      response: orderStatsExample,
    },
  ],
});
