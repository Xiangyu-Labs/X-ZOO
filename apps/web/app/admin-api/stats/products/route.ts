import { statsProducts } from '@shop/contracts/stats/stats.admin.contract';
import * as stats from '@shop/core/stats';
import { handle } from '../../../../src/server';

/** `/admin-api/stats/products` — 商品统计: traffic, carts, orders and refunds. */
export const GET = handle(statsProducts, (ctx, { query }) => stats.productStats(ctx, query));

export const dynamic = 'force-dynamic';
