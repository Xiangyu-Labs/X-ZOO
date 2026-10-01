import { orderAdminDeleteMany } from '@shop/contracts/order/order.admin.contract';
import { orderConsole } from '@shop/core/order';
import { handle } from '../../../../src/server';

/** `/admin-api/orders/deletions` — the batch file-away. Skips what it cannot delete. */
export const POST = handle(orderAdminDeleteMany, async (ctx, { body }) => {
  const result = await orderConsole.adminDeleteMany(ctx, body);
  ctx.audit(`orders:${body.ids.join(',')}`);
  return result;
});

export const dynamic = 'force-dynamic';
