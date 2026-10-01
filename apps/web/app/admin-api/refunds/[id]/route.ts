import { refundAdminDetail } from '@shop/contracts/refund/refund.admin.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../src/server';

/** `/admin-api/refunds/:id` — the request, its lines, and its whole timeline. */
export const GET = handle(refundAdminDetail, (ctx, { params }) => refund.adminDetail(ctx, params));

export const dynamic = 'force-dynamic';
