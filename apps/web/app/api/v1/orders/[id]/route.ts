import { orderGetDetail, orderHide } from '@shop/contracts/order/order.checkout.contract';
import * as order from '@shop/core/order';
import { handle } from '../../../../../src/server';

/** `/api/v1/orders/:id` — 订单详情. A stranger and an unknown id get the same 404. */
export const GET = handle(orderGetDetail, (ctx, { params }) => order.detail(ctx, params));

/**
 * 删除订单 — the buyer's list stops showing a finished order, and the shop keeps
 * every row of it. `DELETE` is the verb the tap means, not what it
 * does; the audit trail records who asked.
 */
export const DELETE = handle(orderHide, (ctx, { params }) => {
  ctx.audit(`order:${params.id}`);
  return order.hide(ctx, params);
});

export const dynamic = 'force-dynamic';
