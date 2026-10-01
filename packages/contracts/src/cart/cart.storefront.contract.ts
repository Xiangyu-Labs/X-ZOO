import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  cartAddBody,
  cartCount,
  cartCountExample,
  cartItemExample,
  cartList,
  cartListExample,
  cartListQuery,
  cartMutationResult,
  cartRebuyBody,
  cartRebuyResult,
  cartRemoveBody,
  cartSelectionBody,
  cartUpdateBody,
} from './schemas';

/**
 * Storefront cart routes, `/api/v1/cart`.
 *
 * Every one of them is `auth: 'user'`: there is no anonymous cart. The
 * collection is `/cart/items`, and the two things that are not CRUD — bulk
 * removal and bulk ticking — are POSTed sub-resources, as `docs/conventions.md`
 * requires.
 *
 * Every mutation answers with the fresh `cart` counters so the tab-bar badge
 * never needs a second round trip.
 */

export const cartGetList = defineRoute({
  id: 'cart.list',
  method: 'GET',
  path: '/api/v1/cart',
  auth: 'user',
  summary: '购物车列表',
  tags: ['cart'],
  query: cartListQuery,
  response: cartList,
  examples: [
    {
      name: 'ok',
      query: { page: 1, pageSize: 20, filter: 'all' },
      response: cartListExample,
    },
    {
      name: 'with-a-dead-row',
      query: { page: 1, pageSize: 20, filter: 'all' },
      response: {
        ...cartListExample,
        items: [
          cartItemExample,
          {
            ...cartItemExample,
            id: '5002',
            skuId: '22',
            productId: '12',
            quantity: 1,
            isSelected: false,
            available: false,
            state: 'off_shelf',
            productName: '已下架的春节礼盒',
            specText: '标准装',
            unitPrice: '99.00',
            originalUnitPrice: null,
            subtotal: '99.00',
            skuImageUrl: null,
            unitName: null,
            stock: 0,
          },
        ],
        total: 2,
        availableCount: 1,
        unavailableCount: 1,
      },
    },
    {
      // A lifetime limit used up: greyed, and the rule says why (每人限购 2 件，已购 2 件).
      name: 'over-a-lifetime-limit',
      query: { page: 1, pageSize: 20, filter: 'all' },
      response: {
        ...cartListExample,
        items: [
          {
            ...cartItemExample,
            quantity: 1,
            subtotal: '60.00',
            isSelected: false,
            available: false,
            state: 'quantity_not_allowed',
            quantityRule: { kind: 'lifetime', limit: 2, purchased: 2 },
          },
        ],
        total: 1,
        availableCount: 0,
        unavailableCount: 1,
        selectedQuantity: 0,
        selectedTotal: '0.00',
      },
    },
  ],
});

export const cartGetCount = defineRoute({
  id: 'cart.count',
  method: 'GET',
  path: '/api/v1/cart/count',
  auth: 'user',
  summary: '购物车数量',
  tags: ['cart'],
  response: cartCount,
  examples: [{ name: 'ok', response: cartCountExample }],
});

export const cartAddItem = defineRoute({
  id: 'cart.addItem',
  method: 'POST',
  path: '/api/v1/cart/items',
  auth: 'user',
  summary: '加入购物车',
  tags: ['cart'],
  body: cartAddBody,
  response: cartMutationResult,
  status: 201,
  errors: [
    'CART_SKU_NOT_AVAILABLE',
    'CART_OUT_OF_STOCK',
    'CART_VIRTUAL_CARD_QUANTITY',
    'CART_PURCHASE_LIMIT_REACHED',
    'CART_BELOW_MIN_PURCHASE',
  ],
  examples: [
    {
      name: 'ok',
      body: { skuId: '21', quantity: 2 },
      response: { item: cartItemExample, cart: cartCountExample },
    },
  ],
});

export const cartUpdateItem = defineRoute({
  id: 'cart.updateItem',
  method: 'PATCH',
  path: '/api/v1/cart/items/:id',
  auth: 'user',
  summary: '修改购物车商品',
  tags: ['cart'],
  params: z.object({ id }),
  body: cartUpdateBody,
  response: cartMutationResult,
  errors: [
    'CART_ITEM_NOT_FOUND',
    'CART_OUT_OF_STOCK',
    'CART_VIRTUAL_CARD_QUANTITY',
    'CART_PURCHASE_LIMIT_REACHED',
    'CART_BELOW_MIN_PURCHASE',
  ],
  examples: [
    {
      name: 'set-quantity',
      params: { id: '5001' },
      body: { quantity: 3 },
      response: {
        item: { ...cartItemExample, quantity: 3, subtotal: '180.00' },
        cart: { ...cartCountExample, quantity: 6 },
      },
    },
    {
      name: 'untick',
      params: { id: '5001' },
      body: { isSelected: false },
      response: {
        item: { ...cartItemExample, isSelected: false },
        cart: cartCountExample,
      },
    },
    {
      // 修改规格 with nothing already in the cart for the new variant: same row,
      // new SKU, quantity carried over.
      name: 'change-sku',
      params: { id: '5001' },
      body: { skuId: '22' },
      response: {
        item: {
          ...cartItemExample,
          skuId: '22',
          specText: '原味装|500g',
          skuImageUrl: 'https://cdn.example.com/sku/22.jpg',
          unitPrice: '45.00',
          subtotal: '90.00',
        },
        cart: cartCountExample,
      },
    },
    {
      // 修改规格 onto a variant the cart already holds: the two rows fold and
      // the answer is the survivor, whose id is not the one that was PATCHed.
      name: 'change-sku-merging-into-an-existing-row',
      params: { id: '5001' },
      body: { skuId: '22' },
      response: {
        item: {
          ...cartItemExample,
          id: '5002',
          skuId: '22',
          specText: '原味装|500g',
          skuImageUrl: 'https://cdn.example.com/sku/22.jpg',
          quantity: 3,
          unitPrice: '45.00',
          subtotal: '135.00',
        },
        cart: { ...cartCountExample, items: 2, quantity: 4 },
      },
    },
  ],
});

/**
 * The same operation as `cart.updateItem`, on `PUT`.
 *
 * `wx.request` has no `PATCH`, so the mini-program cannot call `cart.updateItem`.
 * Same body, same service, same answers; `cart.updateItem` (`PATCH`) stays
 * for a client that can send it.
 */
export const cartUpdateItemPut = defineRoute({
  ...cartUpdateItem,
  id: 'cart.updateItemPut',
  method: 'PUT',
  summary: '修改购物车商品（PUT，小程序）',
});

export const cartRemoveItem = defineRoute({
  id: 'cart.removeItem',
  method: 'DELETE',
  path: '/api/v1/cart/items/:id',
  auth: 'user',
  summary: '删除购物车商品',
  tags: ['cart'],
  params: z.object({ id }),
  response: cartMutationResult,
  errors: ['CART_ITEM_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      params: { id: '5001' },
      response: { item: null, cart: { ...cartCountExample, items: 2, quantity: 3 } },
    },
  ],
});

/**
 * Bulk removal, including 清空失效商品.
 *
 * A POSTed sub-resource rather than `DELETE /cart/items?ids=` because the id
 * list is unbounded in practice and a DELETE takes no body (`defineRoute`
 * enforces that).
 */
export const cartRemoveItems = defineRoute({
  id: 'cart.removeItems',
  method: 'POST',
  path: '/api/v1/cart/items/removals',
  auth: 'user',
  summary: '批量删除购物车商品',
  tags: ['cart'],
  body: cartRemoveBody,
  response: z.object({ removed: z.number().int().min(0), cart: cartCount }),
  examples: [
    {
      name: 'by-id',
      body: { itemIds: ['5001', '5002'], unavailableOnly: false },
      response: {
        removed: 2,
        cart: { items: 1, quantity: 1, availableCount: 1, unavailableCount: 0 },
      },
    },
    {
      name: 'clear-dead-rows',
      body: { itemIds: [], unavailableOnly: true },
      response: {
        removed: 1,
        cart: { items: 2, quantity: 4, availableCount: 2, unavailableCount: 0 },
      },
    },
  ],
});

/** Answers with the whole cart (every row, one page): the storefront swaps it in for its own. */
export const cartSetSelection = defineRoute({
  id: 'cart.setSelection',
  method: 'POST',
  path: '/api/v1/cart/selections',
  auth: 'user',
  summary: '勾选购物车商品',
  tags: ['cart'],
  body: cartSelectionBody,
  response: cartList,
  examples: [
    {
      name: 'select-all',
      body: { itemIds: [], all: true, isSelected: true },
      response: cartListExample,
    },
    {
      name: 'untick-one',
      body: { itemIds: ['5001'], all: false, isSelected: false },
      response: {
        ...cartListExample,
        items: [{ ...cartItemExample, isSelected: false }],
        selectedQuantity: 0,
        selectedTotal: '0.00',
      },
    },
  ],
});

/**
 * 再次购买. It puts the order's still-sellable variants back in the real cart
 * and reports what it could not, rather than pricing a separate pseudo cart
 * built from the old order.
 */
export const cartRebuy = defineRoute({
  id: 'cart.rebuy',
  method: 'POST',
  path: '/api/v1/cart/rebuys',
  auth: 'user',
  summary: '再次购买',
  tags: ['cart'],
  body: cartRebuyBody,
  response: cartRebuyResult,
  status: 201,
  errors: ['ORDER_NOT_FOUND'],
  examples: [
    {
      name: 'partly-available',
      body: { orderId: '9001' },
      response: {
        added: 1,
        skippedSkuIds: ['22'],
        cart: { items: 2, quantity: 3, availableCount: 2, unavailableCount: 0 },
      },
    },
  ],
});
