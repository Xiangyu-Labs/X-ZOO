import { refundAdminCreate } from '@shop/contracts/refund/refund.admin.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/orders/:id/refunds` — 商家发起售后.
 *
 * Opens already approved: a 仅退款 queues the gateway call, a 退货退款 waits for
 * the goods.
 */
export const POST = handle(refundAdminCreate, async (ctx, { params, body }) => {
  const created = await refund.adminCreate(ctx, { ...body, id: params.id });
  ctx.audit(`refund:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
