import { cartAddItem } from '@shop/contracts/cart/cart.storefront.contract';
import * as cart from '@shop/core/cart';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/cart/items` — 加入购物车.
 *
 * Adding is relative: two taps of `1` leave `2`. The absolute form is the
 * `PATCH` on a single item.
 */
export const POST = handle(cartAddItem, (ctx, { body }) => cart.addItem(ctx, body));

export const dynamic = 'force-dynamic';
