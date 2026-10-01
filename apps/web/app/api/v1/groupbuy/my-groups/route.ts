import { groupbuyMyGroups } from '@shop/contracts/groupbuy/groupbuy.storefront.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../../src/server';

/** `/api/v1/groupbuy/my-groups` — 我的拼团. */
export const GET = handle(groupbuyMyGroups, (ctx, { query }) => groupbuy.myGroups(ctx, query));

export const dynamic = 'force-dynamic';
