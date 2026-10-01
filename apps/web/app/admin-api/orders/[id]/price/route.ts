import { orderAdminAdjustPrice } from '@shop/contracts/order/order.admin.contract';
import { orderConsole } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/orders/:id/price` — 改价, before payment only.
 *
 * The body names a *discount*; the service recomputes the total and re-splits
 * the per-line shares. There is deliberately no "set the total" field.
 */
export const POST = handle(orderAdminAdjustPrice, async (ctx, { params, body }) => {
  const updated = await orderConsole.adminAdjustPrice(ctx, params, body);
  ctx.audit(`order:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
