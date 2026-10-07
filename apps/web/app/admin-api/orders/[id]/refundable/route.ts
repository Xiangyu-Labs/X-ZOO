import { refundAdminApplicable } from '@shop/contracts/refund/refund.admin.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../src/server';

/** `/admin-api/orders/:id/refundable` — 可发起售后的商品, for 商家发起售后. */
export const GET = handle(refundAdminApplicable, (ctx, { params }) =>
  refund.adminApplicable(ctx, params),
);

export const dynamic = 'force-dynamic';
