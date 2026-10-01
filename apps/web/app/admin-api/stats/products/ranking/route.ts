import { statsProductRanking } from '@shop/contracts/stats/stats.admin.contract';
import * as stats from '@shop/core/stats';
import { handle } from '../../../../../src/server';

/** `/admin-api/stats/products/ranking` — 商品排行, sorted by the asked-for figure. */
export const GET = handle(statsProductRanking, (ctx, { query }) =>
  stats.productRanking(ctx, query),
);

export const dynamic = 'force-dynamic';
