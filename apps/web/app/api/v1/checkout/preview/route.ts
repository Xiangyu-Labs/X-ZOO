import { checkoutPreviewRoute } from '@shop/contracts/order/order.checkout.contract';
import * as order from '@shop/core/order';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/checkout/preview` — 确认订单.
 *
 * A POST because the cart selection goes in the body, and it writes nothing,
 * so the client may call it on every address or coupon change. The server
 * re-prices from scratch every time; there is no draft to go stale.
 */
export const POST = handle(checkoutPreviewRoute, (ctx, { body }) => order.preview(ctx, body));

export const dynamic = 'force-dynamic';
