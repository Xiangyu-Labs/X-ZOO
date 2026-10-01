import { cartGetCount } from '@shop/contracts/cart/cart.storefront.contract';
import * as cart from '@shop/core/cart';
import { handle } from '../../../../../src/server';

/** `/api/v1/cart/count` — the tab-bar badge. */
export const GET = handle(cartGetCount, (ctx) => cart.count(ctx));

export const dynamic = 'force-dynamic';
