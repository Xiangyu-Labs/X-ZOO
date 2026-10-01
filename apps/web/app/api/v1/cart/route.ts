import { cartGetList } from '@shop/contracts/cart/cart.storefront.contract';
import * as cart from '@shop/core/cart';
import { handle } from '../../../../src/server';

/**
 * `/api/v1/cart` — 购物车列表.
 *
 * The prices, pictures and stock in the response are read live from the
 * catalogue on every call; the cart row itself stores only the variant, the
 * quantity and the tick.
 */
export const GET = handle(cartGetList, (ctx, { query }) => cart.list(ctx, query));

export const dynamic = 'force-dynamic';
