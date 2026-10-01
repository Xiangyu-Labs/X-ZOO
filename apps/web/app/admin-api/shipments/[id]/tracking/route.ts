import { orderAdminShipmentTracking } from '@shop/contracts/order/order.admin.contract';
import { adminTrackShipment } from '@shop/core/order';
import { handle } from '../../../../../src/server';

/** `/admin-api/shipments/:id/tracking` — `available: false` while no provider is configured. */
export const GET = handle(orderAdminShipmentTracking, (ctx, { params }) =>
  adminTrackShipment(ctx, params),
);

export const dynamic = 'force-dynamic';
