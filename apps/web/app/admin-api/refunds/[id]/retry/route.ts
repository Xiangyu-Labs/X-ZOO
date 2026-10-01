import { refundAdminRetry } from '@shop/contracts/refund/refund.admin.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/refunds/:id/retry` — 复核退款结果.
 *
 * Queries a refund that may be in flight and re-sends one the gateway never
 * took — both under the frozen `out_refund_no`, never a new one, which is what
 * makes this safe to press twice.
 */
export const POST = handle(refundAdminRetry, async (ctx, { params }) => {
  const updated = await refund.adminRetry(ctx, params);
  ctx.audit(`refund:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
