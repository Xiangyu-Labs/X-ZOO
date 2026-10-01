import { statsOrders } from '@shop/contracts/stats/stats.admin.contract';
import * as stats from '@shop/core/stats';
import { handle } from '../../../../src/server';

/** `/admin-api/stats/orders` — 订单统计, with the 来源 and 类型 breakdowns. */
export const GET = handle(statsOrders, (ctx, { query }) => stats.orderStats(ctx, query));

export const dynamic = 'force-dynamic';
