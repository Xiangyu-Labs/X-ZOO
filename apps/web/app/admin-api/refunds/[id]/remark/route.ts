import { refundAdminRemark } from '@shop/contracts/refund/refund.admin.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../src/server';

/** `/admin-api/refunds/:id/remark` — 售后备注. */
export const POST = handle(refundAdminRemark, async (ctx, { params, body }) => {
  const updated = await refund.adminRemark(ctx, { ...body, id: params.id });
  ctx.audit(`refund:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
