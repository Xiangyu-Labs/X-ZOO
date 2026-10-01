import { orderAdminDelete, orderAdminDetail } from '@shop/contracts/order/order.admin.contract';
import { orderConsole } from '@shop/core/order';
import { handle } from '../../../../src/server';

/** `/admin-api/orders/:id` — one order, and filing it away once it is finished. */
export const GET = handle(orderAdminDetail, (ctx, { params }) =>
  orderConsole.adminDetail(ctx, params),
);

export const DELETE = handle(orderAdminDelete, async (ctx, { params }) => {
  await orderConsole.adminDelete(ctx, params);
  ctx.audit(`order:${params.id}`);
  return { id: params.id, deleted: true as const };
});

export const dynamic = 'force-dynamic';
