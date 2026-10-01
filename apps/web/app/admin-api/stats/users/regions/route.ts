import { statsUserRegions } from '@shop/contracts/stats/stats.admin.contract';
import * as stats from '@shop/core/stats';
import { handle } from '../../../../../src/server';

/** `/admin-api/stats/users/regions` — 用户地域分布, one row per province. */
export const GET = handle(statsUserRegions, (ctx, { query }) => stats.userRegions(ctx, query));

export const dynamic = 'force-dynamic';
