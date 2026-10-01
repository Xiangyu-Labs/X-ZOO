import { orderConfirmReceipt } from '@shop/contracts/order/order.fulfil.contract';
import { confirmReceipt } from '@shop/core/order';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/orders/:id/receipt` — 确认收货.
 *
 * One conditional `shipped -> received`. The operator's button and the
 * auto-receive job run the same one, so whoever loses the race simply finds it
 * already done.
 */
export const POST = handle(orderConfirmReceipt, (ctx, { params, body }) =>
  confirmReceipt(ctx, params, body),
);

export const dynamic = 'force-dynamic';
