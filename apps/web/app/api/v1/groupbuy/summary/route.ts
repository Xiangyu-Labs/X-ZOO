import { groupbuySummaryRoute } from '@shop/contracts/groupbuy/groupbuy.storefront.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../../src/server';

/** `/api/v1/groupbuy/summary` — the 人气条 on the 拼团 tab. Public, cached 60 s. */
export const GET = handle(groupbuySummaryRoute, (ctx) => groupbuy.summary(ctx));

export const dynamic = 'force-dynamic';
