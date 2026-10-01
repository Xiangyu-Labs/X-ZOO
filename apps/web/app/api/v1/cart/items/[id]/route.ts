import {
  cartRemoveItem,
  cartUpdateItem,
  cartUpdateItemPut,
} from '@shop/contracts/cart/cart.storefront.contract';
import * as cart from '@shop/core/cart';
import { handle } from '../../../../../../src/server';

/** `/api/v1/cart/items/:id` — set the quantity or the tick, or remove the row. */
export const PATCH = handle(cartUpdateItem, (ctx, { params, body }) =>
  cart.updateItem(ctx, params, body),
);

/** The same, on `PUT`: `wx.request` cannot send `PATCH`. */
export const PUT = handle(cartUpdateItemPut, (ctx, { params, body }) =>
  cart.updateItem(ctx, params, body),
);

export const DELETE = handle(cartRemoveItem, (ctx, { params }) => cart.removeItem(ctx, params));

export const dynamic = 'force-dynamic';
