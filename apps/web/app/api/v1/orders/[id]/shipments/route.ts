import { orderMyShipments } from '@shop/contracts/order/order.fulfil.contract';
import { myShipments } from '@shop/core/order';
import { handle } from '../../../../../../src/server';

/** `/api/v1/orders/:id/shipments` — 物流 on the buyer's order page. */
export const GET = handle(orderMyShipments, (ctx, { params }) => myShipments(ctx, params));

export const dynamic = 'force-dynamic';
