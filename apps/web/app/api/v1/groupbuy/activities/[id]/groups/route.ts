import { groupbuyOpenGroups } from '@shop/contracts/groupbuy/groupbuy.storefront.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../../../../src/server';

/**
 * `/api/v1/groupbuy/activities/:id/groups` — teams a shopper may still join.
 *
 * A team appears here only once it holds a seat, i.e. once its leader has paid.
 * Listing unpaid teams too would land 参团 on a team that silently expires
 * without ever existing.
 */
export const GET = handle(groupbuyOpenGroups, (ctx, { params, query }) =>
  groupbuy.openGroups(ctx, params, query),
);

export const dynamic = 'force-dynamic';
