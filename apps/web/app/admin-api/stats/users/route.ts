import { statsUsers } from '@shop/contracts/stats/stats.admin.contract';
import * as stats from '@shop/core/stats';
import { handle } from '../../../../src/server';

/** `/admin-api/stats/users` — 用户统计: registrations, buyers and traffic. */
export const GET = handle(statsUsers, (ctx, { query }) => stats.userStats(ctx, query));

export const dynamic = 'force-dynamic';
