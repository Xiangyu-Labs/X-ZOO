import { orderCancel } from '@shop/contracts/order/order.checkout.contract';
import * as order from '@shop/core/order';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/orders/:id/cancel` — 取消订单.
 *
 * A POSTed sub-resource, not a DELETE: cancelling is a state transition with
 * side effects — the stock and the coupon come back — and the order row
 * survives it.
 */
export const POST = handle(orderCancel, (ctx, { params, body }) => order.cancel(ctx, params, body));

export const dynamic = 'force-dynamic';
