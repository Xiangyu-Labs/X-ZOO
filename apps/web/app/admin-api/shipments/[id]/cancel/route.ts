import { orderAdminCancelShipment } from '@shop/contracts/order/order.admin.contract';
import { cancelShipment } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/** `/admin-api/shipments/:id/cancel` — 撤销发货, only while the order is still `paid`. */
export const POST = handle(orderAdminCancelShipment, async (ctx, { params, body }) => {
  const shipment = await cancelShipment(ctx, params, body);
  ctx.audit(`shipment:${params.id}`);
  return shipment;
});

export const dynamic = 'force-dynamic';
