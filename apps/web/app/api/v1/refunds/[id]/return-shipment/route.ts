import { refundSubmitReturnShipment } from '@shop/contracts/refund/refund.storefront.contract';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../../src/server';

/** `/api/v1/refunds/:id/return-shipment` — 买家填写退货物流. */
export const POST = handle(refundSubmitReturnShipment, (ctx, { params, body }) =>
  refund.submitReturnShipment(ctx, { ...body, id: params.id }),
);

export const dynamic = 'force-dynamic';
