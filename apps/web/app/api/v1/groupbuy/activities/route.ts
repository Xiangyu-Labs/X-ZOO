import { groupbuyList } from '@shop/contracts/groupbuy/groupbuy.storefront.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/groupbuy/activities` — the 拼团 channel list, and a DIY 拼团
 * component's picked activities when `ids` is given; `groupbuy.list` decides
 * which.
 */
export const GET = handle(groupbuyList, (ctx, { query }) => groupbuy.list(ctx, query));

export const dynamic = 'force-dynamic';
