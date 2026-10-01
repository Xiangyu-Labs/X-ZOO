import type { CartItemState, CartQuantityRule } from '@shop/contracts/cart/schemas';
import type { SkuForSale } from '../order';

/**
 * What a cart row is allowed to be, as pure functions.
 *
 * The rule the whole file exists for: **a cart row is never silently deleted**.
 * Dropping unsellable rows from the response is how a shopper ends up asking
 * support where their basket went. So a dead row comes back with a `state` and
 * `available: false`, greyed out, with a 清空失效商品 button next to it.
 */

/** The most units one cart row may ever hold, whatever the shopper types. */
export const MAX_CART_QUANTITY = 9999;

/** How many rows one cart may hold. Beyond this the storefront stops paging. */
export const MAX_CART_ROWS = 300;

/**
 * `purchased`: units of the product this shopper already bought, for a
 * `lifetime` limit (0 when the caller did not look them up). Checkout refuses
 * a row past it, so the cart greys it out first instead of letting 结算 lead
 * to a refusal.
 */
export function stateOf(
  sku: SkuForSale | undefined,
  quantity: number,
  purchased = 0,
): CartItemState {
  if (!sku || sku.deleted) return 'deleted';
  if (!sku.onSale) return 'off_shelf';
  if (brokenRule(sku, quantity, purchased)) return 'quantity_not_allowed';
  if (sku.stock < quantity) return 'out_of_stock';
  return 'ok';
}

/** The quantity rule a live row breaks, or `null`. */
function brokenRule(sku: SkuForSale, quantity: number, purchased: number): CartQuantityRule | null {
  // `product_virtual_cards_order_item_uq`: one card key binds to one order
  // item, so a card variant can never be checked out more than one at a time.
  if (sku.productKind === 'virtual_card' && quantity > 1) {
    return { kind: 'virtual_card', limit: 1, purchased: null };
  }
  if (quantity < sku.minPurchaseQuantity) {
    return { kind: 'min_purchase', limit: sku.minPurchaseQuantity, purchased: null };
  }
  const limit = sku.purchaseLimitQuantity;
  if (sku.purchaseLimitMode === 'per_order' && limit !== null && quantity > limit) {
    return { kind: 'per_order', limit, purchased: null };
  }
  if (sku.purchaseLimitMode === 'lifetime' && limit !== null && purchased + quantity > limit) {
    return { kind: 'lifetime', limit, purchased };
  }
  return null;
}

/**
 * What the storefront says about a row's quantity: the rule it breaks, or, for
 * a row within a lifetime limit, that limit (每人限购 2 件，已购 1 件) so the
 * shopper is not surprised at checkout. `null` for a gone row or no rule.
 */
export function quantityRuleOf(
  sku: SkuForSale | undefined,
  quantity: number,
  purchased = 0,
): CartQuantityRule | null {
  if (!sku || sku.deleted || !sku.onSale) return null;
  const broken = brokenRule(sku, quantity, purchased);
  if (broken) return broken;
  if (sku.purchaseLimitMode === 'lifetime' && sku.purchaseLimitQuantity !== null) {
    return { kind: 'lifetime', limit: sku.purchaseLimitQuantity, purchased };
  }
  return null;
}

export const isAvailable = (state: CartItemState): boolean => state === 'ok';

/**
 * The quantity checks for a *write* — adding to the cart, or setting an
 * absolute quantity. These throw, because the shopper asked for something the
 * cart cannot hold, unlike `stateOf`, which only describes what is already
 * there.
 */
export interface QuantityRefusal {
  code:
    | 'CART_SKU_NOT_AVAILABLE'
    | 'CART_OUT_OF_STOCK'
    | 'CART_VIRTUAL_CARD_QUANTITY'
    | 'CART_PURCHASE_LIMIT_REACHED'
    | 'CART_BELOW_MIN_PURCHASE';
  details?: Record<string, unknown>;
}

/** `null` when the quantity is fine. Never throws — the service maps and throws. */
export function refuseQuantity(
  sku: SkuForSale | undefined,
  quantity: number,
): QuantityRefusal | null {
  if (!sku || sku.deleted || !sku.onSale) return { code: 'CART_SKU_NOT_AVAILABLE' };
  if (sku.productKind === 'virtual_card' && quantity > 1) {
    return { code: 'CART_VIRTUAL_CARD_QUANTITY' };
  }
  if (quantity < sku.minPurchaseQuantity) {
    return { code: 'CART_BELOW_MIN_PURCHASE', details: { minimum: sku.minPurchaseQuantity } };
  }
  const limit = sku.purchaseLimitQuantity;
  if (sku.purchaseLimitMode !== 'none' && limit !== null && quantity > limit) {
    return { code: 'CART_PURCHASE_LIMIT_REACHED', details: { limit } };
  }
  if (sku.stock < quantity) return { code: 'CART_OUT_OF_STOCK', details: { stock: sku.stock } };
  return null;
}

/**
 * The quantity an add may reach: never past the shop's cap or the variant's.
 *
 * It is both the clamp `addUnits` applies and the `cap` the storefront's
 * stepper is told about, so a kind that `refuseQuantity` would refuse has to
 * be capped here too — otherwise the stepper offers a number the next request
 * answers with a 422.
 */
export function capFor(sku: SkuForSale): number {
  // `product_virtual_cards_order_item_uq`: one card key per order item, so the
  // stepper on a 卡密 product does not go past 1.
  if (sku.productKind === 'virtual_card') return 1;
  const limit =
    sku.purchaseLimitMode !== 'none' && sku.purchaseLimitQuantity !== null
      ? sku.purchaseLimitQuantity
      : MAX_CART_QUANTITY;
  return Math.max(1, Math.min(MAX_CART_QUANTITY, limit));
}
