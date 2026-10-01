import { orderAdminUpdateAddress } from '@shop/contracts/order/order.admin.contract';
import { orderConsole } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/** `/admin-api/orders/:id/address` — the snapshot on the order, never the address book. */
export const POST = handle(orderAdminUpdateAddress, async (ctx, { params, body }) => {
  const updated = await orderConsole.adminUpdateAddress(ctx, params, body);
  ctx.audit(`order:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
