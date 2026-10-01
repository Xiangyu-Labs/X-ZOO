import { orderCountsRoute } from '@shop/contracts/order/order.checkout.contract';
import * as order from '@shop/core/order';
import { handle } from '../../../../../src/server';

/** `/api/v1/orders/counts` — the tab badges, from one grouped query. */
export const GET = handle(orderCountsRoute, (ctx) => order.counts(ctx));

export const dynamic = 'force-dynamic';
