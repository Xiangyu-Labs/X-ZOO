import { orderCreate, orderList } from '@shop/contracts/order/order.checkout.contract';
import * as order from '@shop/core/order';
import { handle } from '../../../../src/server';

/**
 * `/api/v1/orders` — 我的订单 and 提交订单.
 *
 * A second POST with the same `idempotencyKey` returns the first order rather
 * than creating another; the uniqueness lives in the creating transaction, not
 * in a Redis lock.
 */
export const GET = handle(orderList, (ctx, { query }) => order.list(ctx, query));

export const POST = handle(orderCreate, (ctx, { body }) => order.create(ctx, body));

export const dynamic = 'force-dynamic';
