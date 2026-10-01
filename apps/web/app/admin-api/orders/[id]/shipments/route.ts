import { orderAdminShip, orderAdminShipments } from '@shop/contracts/order/order.admin.contract';
import { adminShip, orderConsole } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/orders/:id/shipments` — what went out, and 发货.
 *
 * A dispatch is a POST to a sub-collection because that is what it is: a new
 * shipment. There is no order splitting, so no parent/child order is created.
 */
export const GET = handle(orderAdminShipments, (ctx, { params }) =>
  orderConsole.adminShipments(ctx, params),
);

export const POST = handle(orderAdminShip, async (ctx, { params, body }) => {
  const shipment = await adminShip(ctx, params, body);
  ctx.audit(`order:${params.id}`);
  return shipment;
});

export const dynamic = 'force-dynamic';
