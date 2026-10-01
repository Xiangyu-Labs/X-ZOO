import { refundAdminReceiveReturn } from '@shop/contracts/refund/refund.admin.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/refunds/:id/receive-return` — 确认收到退货并退款.
 *
 * Persists `processing` before anything is sent, so a crash between the commit
 * and the gateway call leaves a row the sweep finishes rather than a refund
 * nobody knows about.
 */
export const POST = handle(refundAdminReceiveReturn, async (ctx, { params, body }) => {
  const updated = await refund.adminReceiveReturn(ctx, { ...body, id: params.id });
  ctx.audit(`refund:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
