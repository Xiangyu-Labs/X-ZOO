import { refundAdminWithdraw } from '@shop/contracts/refund/refund.admin.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../src/server';

/** `/admin-api/refunds/:id/withdraw` — 撤销商家发起的售后. */
export const POST = handle(refundAdminWithdraw, async (ctx, { params, body }) => {
  const updated = await refund.adminWithdraw(ctx, { ...body, id: params.id });
  ctx.audit(`refund:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
