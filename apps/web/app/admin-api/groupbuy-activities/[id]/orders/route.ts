import { groupbuyAdminActivityOrders } from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/groupbuy-activities/:id/orders` — 拼团订单.
 *
 * Gated on `groupbuy:group:read` rather than `groupbuy:activity:read`: this is
 * shopper data, and the person who edits a campaign is not always the person
 * allowed to read who bought from it.
 */
export const GET = handle(groupbuyAdminActivityOrders, (ctx, { params, query }) =>
  groupbuy.adminActivityOrders(ctx, params, query),
);

export const dynamic = 'force-dynamic';
