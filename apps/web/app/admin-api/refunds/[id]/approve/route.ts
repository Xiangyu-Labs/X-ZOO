import { refundAdminApprove } from '@shop/contracts/refund/refund.admin.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/refunds/:id/approve` — 同意退款.
 *
 * Does not send money. A `refund_only` queues the gateway call as an effect; a
 * `return_and_refund` waits for 确认收货.
 */
export const POST = handle(refundAdminApprove, async (ctx, { params, body }) => {
  const updated = await refund.adminApprove(ctx, { ...body, id: params.id });
  ctx.audit(`refund:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
