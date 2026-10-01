import { refundAdminList } from '@shop/contracts/refund/refund.admin.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../src/server';

/** `/admin-api/refunds` — 售后单列表. */
export const GET = handle(refundAdminList, (ctx, { query }) => refund.adminList(ctx, query));

export const dynamic = 'force-dynamic';
