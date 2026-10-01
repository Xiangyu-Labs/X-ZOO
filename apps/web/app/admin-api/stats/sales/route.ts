import { statsSales } from '@shop/contracts/stats/stats.admin.contract';
import * as stats from '@shop/core/stats';
import { handle } from '../../../../src/server';

/** `/admin-api/stats/sales` — 销售看板: 交易 and 订单 figures with 同比, 时段分布, 分类销售. */
export const GET = handle(statsSales, (ctx, { query }) => stats.salesStats(ctx, query));

export const dynamic = 'force-dynamic';
