import { presaleAdminOrderList } from '@shop/contracts/presale/presale.admin.contract';
import * as presale from '@shop/core/presale';
import { handle } from '../../../src/server';

/**
 * `/admin-api/presale-orders` — 预售订单.
 *
 * Read-only: everything an operator *does* to a presale order (ship it, refund
 * it, close it) is done to the order, on the order and refund screens. This list exists
 * to answer "what did we promise and when may it leave", which is the one
 * question the ordinary order list cannot answer.
 */
export const GET = handle(presaleAdminOrderList, (ctx, { query }) =>
  presale.adminOrderList(ctx, query),
);

export const dynamic = 'force-dynamic';
