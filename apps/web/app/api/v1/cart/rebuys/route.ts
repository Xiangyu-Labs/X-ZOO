import { cartRebuy } from '@shop/contracts/cart/cart.storefront.contract';
import * as cart from '@shop/core/cart';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/cart/rebuys` — 再次购买.
 *
 * Reports what it managed to put back rather than refusing: products go off
 * shelf between orders, and a partial result is the normal case.
 */
export const POST = handle(cartRebuy, (ctx, { body }) => cart.rebuy(ctx, body));

export const dynamic = 'force-dynamic';
