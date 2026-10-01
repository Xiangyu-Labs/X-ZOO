import { refundAdminReject } from '@shop/contracts/refund/refund.admin.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../src/server';

/** `/admin-api/refunds/:id/reject` — 拒绝退款. The reason is required, in the contract and in a CHECK. */
export const POST = handle(refundAdminReject, async (ctx, { params, body }) => {
  const updated = await refund.adminReject(ctx, { ...body, id: params.id });
  ctx.audit(`refund:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
