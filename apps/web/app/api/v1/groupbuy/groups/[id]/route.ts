import { groupbuyGroupDetailRoute } from '@shop/contracts/groupbuy/groupbuy.storefront.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../../../src/server';

/** `/api/v1/groupbuy/groups/:id` — the 拼团状态页 a share link opens. */
export const GET = handle(groupbuyGroupDetailRoute, (ctx, { params }) =>
  groupbuy.groupDetail(ctx, params),
);

export const dynamic = 'force-dynamic';
