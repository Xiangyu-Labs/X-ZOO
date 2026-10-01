import { z } from 'zod';
import { id, instant, money, pageQuery, paged } from '../_conventions/common';

/**
 * Cart shapes.
 *
 * The cart is one row per `(user, sku)` — adding the same variant twice bumps
 * the quantity rather than growing a second row — so a cart item id is stable
 * for as long as the variant stays in the cart, and the storefront may key its
 * list on it.
 *
 * Every zod enum here duplicates a PostgreSQL enum by hand, because
 * `packages/contracts` is the bottom layer and may not import `@shop/db`. The
 * service assigns one to the other and stops compiling if they drift.
 */

/** Mirrors `products_kind`. */
export const productKind = z.enum(['physical', 'virtual_card', 'virtual_coupon', 'virtual_manual']);
export type ProductKind = z.infer<typeof productKind>;

/**
 * Why a cart row cannot be checked out.
 *
 * `ok` is the only value that lets a line into an order. The rest are shown
 * greyed out with a reason instead of being deleted behind the shopper's back:
 * rows that silently vanish are how a customer ends up asking support where
 * their basket went.
 */
export const cartItemState = z.enum([
  'ok',
  /** The product or the variant is gone. */
  'deleted',
  /** The product is `draft` or `off_shelf`, or the variant is hidden. */
  'off_shelf',
  /** Live, but `stock < quantity`. */
  'out_of_stock',
  /** The quantity breaks a rule of the product: `quantityRule` says which. */
  'quantity_not_allowed',
]);
export type CartItemState = z.infer<typeof cartItemState>;

/**
 * The quantity rule a row runs into, so the storefront can say which (and how far to lower
 * it): a 卡密 is one per order, a minimum (起购), a per-order limit, or a lifetime limit with
 * the units already bought. On a `quantity_not_allowed` row it is the rule broken; on an `ok`
 * row it is a lifetime limit, shown as a note. `null` when no rule binds.
 */
export const cartQuantityRule = z.object({
  kind: z.enum(['virtual_card', 'min_purchase', 'per_order', 'lifetime']),
  /** 1 for a card; the minimum; the per-order or lifetime limit. */
  limit: z.number().int().min(0),
  /** `lifetime`: units already bought on paid, not refunded orders. `null` otherwise. */
  purchased: z.number().int().min(0).nullable(),
});
export type CartQuantityRule = z.infer<typeof cartQuantityRule>;

export const cartItem = z.object({
  id,
  productId: id,
  skuId: id,
  quantity: z.number().int().min(1),
  isSelected: z.boolean(),
  /** Whether this row may be checked out; `state` says why not. */
  available: z.boolean(),
  state: cartItemState,
  // --- live catalogue data, read at list time, never stored on the cart row ---
  productName: z.string(),
  productImageUrl: z.string(),
  productKind,
  skuImageUrl: z.string().nullable(),
  specText: z.string(),
  unitName: z.string().nullable(),
  /** Current price of the variant. What the shopper will actually be charged. */
  unitPrice: money,
  /** Crossed-out reference price, when the operator set one. */
  originalUnitPrice: money.nullable(),
  /** `unitPrice * quantity`. */
  subtotal: money,
  /** Live variant stock, so the quantity stepper can cap itself. */
  stock: z.number().int().min(0),
  /** Absent from servers before it existed; treat as `null`. */
  quantityRule: cartQuantityRule.nullable().optional(),
  createdAt: instant,
});
export type CartItem = z.infer<typeof cartItem>;

export const cartItemExample = {
  id: '5001',
  productId: '11',
  skuId: '21',
  quantity: 2,
  isSelected: true,
  available: true,
  state: 'ok',
  productName: '有机三只松鼠坚果礼盒',
  productImageUrl: 'https://cdn.example.com/p/11.jpg',
  productKind: 'physical',
  skuImageUrl: 'https://cdn.example.com/sku/21.jpg',
  specText: '混合装|1000g',
  unitName: '盒',
  unitPrice: '60.00',
  originalUnitPrice: '88.00',
  subtotal: '120.00',
  stock: 42,
  quantityRule: null,
  createdAt: '2026-02-01T10:00:00+08:00',
} satisfies CartItem;

/**
 * A cart page. `selectedTotal` is what the 结算 button shows, and it counts
 * only rows that are both ticked and `available` — an out-of-stock row the
 * shopper ticked last week must not inflate it.
 */
export const cartList = z.object({
  items: z.array(cartItem),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  /** Rows that are `available`, whether ticked or not. */
  availableCount: z.number().int().min(0),
  /** Rows that are not. The storefront offers 清空失效商品 when this is non-zero. */
  unavailableCount: z.number().int().min(0),
  /** Units across ticked, available rows. */
  selectedQuantity: z.number().int().min(0),
  /** Sum of the ticked, available subtotals. Before any coupon or freight. */
  selectedTotal: money,
});
export type CartList = z.infer<typeof cartList>;

export const cartListExample = {
  items: [cartItemExample],
  total: 1,
  page: 1,
  pageSize: 20,
  availableCount: 1,
  unavailableCount: 0,
  selectedQuantity: 2,
  selectedTotal: '120.00',
} satisfies CartList;

export const cartListQuery = pageQuery.extend({
  /** `available` hides the dead rows; the default shows everything. */
  filter: z.enum(['all', 'available', 'unavailable']).default('all'),
});
export type CartListQuery = z.infer<typeof cartListQuery>;

/** Unused, but `paged(cartItem)` keeps the list shape honest if the page ever splits. */
export const pagedCartItems = paged(cartItem);

export const cartCount = z.object({
  /** Number of cart rows, available and not. The tab-bar badge. */
  items: z.number().int().min(0),
  /** Sum of every row's quantity. */
  quantity: z.number().int().min(0),
  availableCount: z.number().int().min(0),
  unavailableCount: z.number().int().min(0),
});
export type CartCount = z.infer<typeof cartCount>;

export const cartCountExample = {
  items: 3,
  quantity: 5,
  availableCount: 2,
  unavailableCount: 1,
} satisfies CartCount;

export const cartAddBody = z.object({
  skuId: id,
  /**
   * Units to add. Adding is relative — `POST` twice with `1` leaves `2` — which
   * is what the 加入购物车 button means. Use `PATCH` to set an absolute value.
   */
  quantity: z.number().int().min(1).max(9999).default(1),
});
export type CartAddBody = z.infer<typeof cartAddBody>;

export const cartUpdateBody = z
  .object({
    /**
     * 修改规格 — move this row onto another variant of the same product.
     *
     * Delete-then-add would lose the row if the second call failed. Here it is
     * one transaction, and the merge rule is the one `addItem` already has: if
     * another row already holds this variant the two fold together and the
     * answer carries the surviving row, whose `id` is then **not** the one that
     * was PATCHed.
     */
    skuId: id.optional(),
    /** Absolute quantity. Omit to leave it alone. */
    quantity: z.number().int().min(1).max(9999).optional(),
    isSelected: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.skuId !== undefined || body.quantity !== undefined || body.isSelected !== undefined,
    { message: '请至少修改规格、数量或勾选状态其中之一' },
  );
export type CartUpdateBody = z.infer<typeof cartUpdateBody>;

export const cartRemoveBody = z
  .object({
    /** Rows to remove. Ignored when `unavailableOnly` is true. */
    itemIds: z.array(id).max(200).default([]),
    /** 清空失效商品: remove every row that is not `available`. */
    unavailableOnly: z.boolean().default(false),
  })
  .refine((body) => body.unavailableOnly || body.itemIds.length > 0, {
    message: '请选择要删除的购物车商品',
  });
export type CartRemoveBody = z.infer<typeof cartRemoveBody>;

export const cartSelectionBody = z
  .object({
    itemIds: z.array(id).max(200).default([]),
    /** Tick or untick every *available* row. `itemIds` is ignored when set. */
    all: z.boolean().default(false),
    isSelected: z.boolean(),
  })
  .refine((body) => body.all || body.itemIds.length > 0, {
    message: '请选择要勾选的购物车商品',
  });
export type CartSelectionBody = z.infer<typeof cartSelectionBody>;

export const cartRebuyBody = z.object({
  /** The order to buy again. Every still-sellable line goes back into the cart. */
  orderId: id,
});
export type CartRebuyBody = z.infer<typeof cartRebuyBody>;

/**
 * What 再次购买 managed to do.
 *
 * A partial result is the normal case — products go off shelf — so this reports
 * rather than refuses. `skippedSkuIds` are the ones the storefront tells the
 * shopper about.
 */
export const cartRebuyResult = z.object({
  added: z.number().int().min(0),
  skippedSkuIds: z.array(id),
  cart: cartCount,
});
export type CartRebuyResult = z.infer<typeof cartRebuyResult>;

export const cartMutationResult = z.object({
  /** The row as it now stands, or `null` when it was removed. */
  item: cartItem.nullable(),
  cart: cartCount,
});
export type CartMutationResult = z.infer<typeof cartMutationResult>;
