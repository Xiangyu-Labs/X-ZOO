import { couponAdminGrantBatch } from '@shop/contracts/coupon/coupon.admin.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../../../src/server';

/** `/admin-api/coupons/:id/grant-batches` — hand this campaign's coupons to everyone a filter matches. */
export const POST = handle(couponAdminGrantBatch, async (ctx, { params, body }) => {
  const result = await coupon.adminGrantBatch(ctx, params, body);
  ctx.audit(`coupon:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
