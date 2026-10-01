import { cartSetSelection } from '@shop/contracts/cart/cart.storefront.contract';
import * as cart from '@shop/core/cart';
import { handle } from '../../../../../src/server';

/** `/api/v1/cart/selections` — tick or untick rows, including 全选. */
export const POST = handle(cartSetSelection, (ctx, { body }) => cart.setSelection(ctx, body));

export const dynamic = 'force-dynamic';
