import { orderMyShipmentTracking } from '@shop/contracts/order/order.fulfil.contract';
import { myShipmentTracking } from '@shop/core/order';
import { handle } from '../../../../../../src/server';

/** `/api/v1/shipments/:id/tracking` — somebody else's parcel gets the same 404 as a missing one. */
export const GET = handle(orderMyShipmentTracking, (ctx, { params }) =>
  myShipmentTracking(ctx, params),
);

export const dynamic = 'force-dynamic';
