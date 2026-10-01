import { orderAdminRemark } from '@shop/contracts/order/order.admin.contract';
import { orderConsole } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/** `/admin-api/orders/:id/remark` — 商家备注. */
export const POST = handle(orderAdminRemark, async (ctx, { params, body }) => {
  const updated = await orderConsole.adminRemark(ctx, params, body);
  ctx.audit(`order:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
