import type { ResponseOf } from '@shop/api-client';

type CartList = ResponseOf<'cart.list'>;
type CartItem = CartList['items'][number];

/** A cart row: 柔雾丝绒礼盒 黑 / M, 2 × 59.00, ticked. */
export function cartItemFixture(overrides: Partial<CartItem> = {}): CartItem {
  return {
    id: '501',
    productId: '12',
    skuId: '103',
    quantity: 2,
    isSelected: true,
    available: true,
    state: 'ok',
    productName: '柔雾丝绒礼盒',
    productImageUrl: '/uploads/p12.jpg',
    productKind: 'physical',
    skuImageUrl: null,
    specText: '黑|M',
    unitName: '盒',
    unitPrice: '59.00',
    originalUnitPrice: null,
    subtotal: '118.00',
    stock: 5,
    createdAt: '2026-09-20T10:00:00+08:00',
    ...overrides,
  };
}

const cents = (money: string) => Math.round(Number(money) * 100);

/** A cart page with the totals the server would compute from its rows. */
export function cartListFixture(items: CartItem[]): CartList {
  const ticked = items.filter((item) => item.available && item.isSelected);
  const total = ticked.reduce((sum, item) => sum + cents(item.subtotal), 0);
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 100,
    availableCount: items.filter((item) => item.available).length,
    unavailableCount: items.filter((item) => !item.available).length,
    selectedQuantity: ticked.reduce((sum, item) => sum + item.quantity, 0),
    selectedTotal: (total / 100).toFixed(2),
  };
}
