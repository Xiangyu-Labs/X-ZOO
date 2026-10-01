import { orderAdminConfirmReceipt } from '@shop/contracts/order/order.admin.contract';
import { orderConsole } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/** `/admin-api/orders/:id/receipt` — 后台确认收货, the same transition the buyer runs. */
export const POST = handle(orderAdminConfirmReceipt, async (ctx, { params }) => {
  const updated = await orderConsole.adminConfirmReceipt(ctx, params);
  ctx.audit(`order:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
