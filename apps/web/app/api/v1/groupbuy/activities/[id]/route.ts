import { groupbuyDetailRoute } from '@shop/contracts/groupbuy/groupbuy.storefront.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/groupbuy/activities/:id` — one campaign.
 *
 * `user-optional`: signed in, the response also carries `myOpenGroupId`, the
 * team this shopper already leads, so the page can offer 继续邀请 instead of a
 * second 开团 that `groupbuy_members_group_user_uq` would refuse.
 */
export const GET = handle(groupbuyDetailRoute, (ctx, { params }) => groupbuy.detail(ctx, params));

export const dynamic = 'force-dynamic';
