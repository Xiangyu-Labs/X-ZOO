import { cartRemoveItems } from '@shop/contracts/cart/cart.storefront.contract';
import * as cart from '@shop/core/cart';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/cart/items/removals` — bulk delete, and 清空失效商品.
 *
 * A POSTed sub-resource rather than `DELETE /cart/items` with a body: a body
 * on DELETE is legal but badly supported, and this is a named operation.
 */
export const POST = handle(cartRemoveItems, (ctx, { body }) => cart.removeItems(ctx, body));

export const dynamic = 'force-dynamic';
