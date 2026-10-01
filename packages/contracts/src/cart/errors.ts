import { defineErrors } from '../_conventions/errors';

/**
 * Cart error codes.
 *
 * The cart is deliberately permissive: a row whose product went off shelf is
 * *listed* with `state: 'off_shelf'`, not an error, because the shopper still
 * has to see it to remove it. These codes are only for the moment a shopper
 * asks for something the cart cannot hold.
 */
export const cartErrors = defineErrors({
  /** The cart row does not exist, or belongs to somebody else. Same message either way. */
  CART_ITEM_NOT_FOUND: { status: 404, message: '购物车中没有这件商品' },
  /** The SKU does not exist, its product is deleted, or neither is on sale. */
  CART_SKU_NOT_AVAILABLE: { status: 409, message: '商品不存在或已下架' },
  /**
   * `stock < quantity` at the moment of the add or the update. A 409 rather
   * than a 422: the request was well formed, the world moved.
   */
  CART_OUT_OF_STOCK: { status: 409, message: '商品库存不足' },
  /**
   * A `virtual_card` product binds one card key to one order item
   * (`product_virtual_cards_order_item_uq`, SCHEMA.md §3.3), so it can only
   * ever be bought one at a time.
   */
  CART_VIRTUAL_CARD_QUANTITY: { status: 422, message: '卡密商品每次只能购买 1 件' },
  /** `products.purchase_limit_mode` / `purchase_limit_quantity`. `details` carries `{ limit }`. */
  CART_PURCHASE_LIMIT_REACHED: { status: 409, message: '超出该商品的限购数量' },
  /** `products.min_purchase_quantity`. `details` carries `{ minimum }`. */
  CART_BELOW_MIN_PURCHASE: { status: 422, message: '未达到该商品的起购数量' },
});

export type CartErrorCode = keyof typeof cartErrors;
