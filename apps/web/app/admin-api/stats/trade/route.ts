import { statsTrade } from '@shop/contracts/stats/stats.admin.contract';
import * as stats from '@shop/core/stats';
import { handle } from '../../../../src/server';

/** `/admin-api/stats/trade` — 交易统计: 营业额, 商品支付金额, 退款, 运费, 客单价. */
export const GET = handle(statsTrade, (ctx, { query }) => stats.tradeStats(ctx, query));

export const dynamic = 'force-dynamic';
