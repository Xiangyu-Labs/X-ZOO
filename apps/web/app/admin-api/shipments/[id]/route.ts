import { orderAdminUpdateShipment } from '@shop/contracts/order/order.admin.contract';
import { updateShipment } from '@shop/core/order';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/shipments/:id` — 修改发货信息.
 *
 * Transport details only. Which lines went out is settled by `shipment_items`
 * and `shipped_quantity`; correcting *that* means cancelling and shipping again.
 */
export const PATCH = handle(orderAdminUpdateShipment, async (ctx, { params, body }) => {
  const shipment = await updateShipment(ctx, params, body);
  ctx.audit(`shipment:${params.id}`);
  return shipment;
});

export const dynamic = 'force-dynamic';
