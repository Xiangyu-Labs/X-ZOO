import { describe, expect, it } from 'vitest';
import { cartItemFixture, cartListFixture } from '@/test/cart-fixture';
import {
  couponHint,
  couponLines,
  quantityCeiling,
  quantityFloor,
  quantityRuleText,
  rescueQuantity,
  selectionOf,
  unavailableReason,
  type ApplicableCoupons,
  type CartItem,
} from './cart-view';

const userCoupon = (minSpend: string, discountAmount: string) => ({
  id: 'uc1',
  templateId: 't1',
  title: '店铺券',
  discountAmount,
  minSpend,
  scope: 'all_products' as const,
  status: 'unused' as const,
  sourceKind: 'claim' as const,
  validFrom: '2026-09-01T00:00:00+08:00',
  validTo: '2026-12-31T23:59:59+08:00',
  usedAt: null,
  createdAt: '2026-09-01T00:00:00+08:00',
});

describe('cart view', () => {
  it('says why a row is greyed, and which can be rescued', () => {
    const short = cartItemFixture({ available: false, state: 'out_of_stock', stock: 1 });
    expect(unavailableReason(short)).toBe('库存不足，仅剩 1 件');
    expect(rescueQuantity(short)).toBe(1);
    const gone = cartItemFixture({ available: false, state: 'off_shelf' });
    expect(unavailableReason(gone)).toBe('商品已下架');
    expect(rescueQuantity(gone)).toBeNull();
    const none = cartItemFixture({ available: false, state: 'out_of_stock', stock: 0 });
    expect(unavailableReason(none)).toBe('已售罄');
  });

  it('names the quantity rule a greyed row breaks, and the quantity that meets it', () => {
    const greyed = (quantity: number, quantityRule: CartItem['quantityRule'], stock = 50) =>
      cartItemFixture({
        available: false,
        state: 'quantity_not_allowed',
        quantity,
        stock,
        quantityRule,
      });

    const card = greyed(3, { kind: 'virtual_card', limit: 1, purchased: null });
    expect(unavailableReason(card)).toBe('该商品每单只能购买 1 件');
    expect(rescueQuantity(card)).toBe(1);

    const minimum = greyed(1, { kind: 'min_purchase', limit: 3, purchased: null });
    expect(unavailableReason(minimum)).toBe('该商品最少购买 3 件');
    expect(rescueQuantity(minimum)).toBe(3);
    // Not enough stock to reach the minimum: nothing to change it to.
    expect(rescueQuantity(greyed(1, minimum.quantityRule, 2))).toBeNull();

    const perOrder = greyed(8, { kind: 'per_order', limit: 5, purchased: null });
    expect(unavailableReason(perOrder)).toBe('该商品每单限购 5 件');
    expect(rescueQuantity(perOrder)).toBe(5);

    const lifetime = greyed(2, { kind: 'lifetime', limit: 3, purchased: 2 });
    expect(unavailableReason(lifetime)).toBe('每人限购 3 件，你已购买 2 件');
    expect(rescueQuantity(lifetime)).toBe(1);
    const usedUp = greyed(1, { kind: 'lifetime', limit: 2, purchased: 2 });
    expect(rescueQuantity(usedUp)).toBeNull();

    // A server that predates `quantityRule` greyed rows only for the one-card limit.
    const older = greyed(2, undefined);
    expect(unavailableReason(older)).toBe('购买数量不符合要求');
    expect(rescueQuantity(older)).toBe(1);
  });

  it('caps a live row by its limit, and says a lifetime limit up front', () => {
    const limited = cartItemFixture({
      quantity: 1,
      stock: 40,
      quantityRule: { kind: 'lifetime', limit: 3, purchased: 1 },
    });
    expect(quantityRuleText(limited)).toBe('每人限购 3 件，你已购买 1 件');
    expect(quantityCeiling(limited)).toBe(2);
    expect(quantityFloor(limited)).toBe(1);
    const fresh = cartItemFixture({ quantityRule: { kind: 'lifetime', limit: 3, purchased: 0 } });
    expect(quantityRuleText(fresh)).toBe('每人限购 3 件');

    const plain = cartItemFixture({ stock: 7, quantityRule: null });
    expect(quantityRuleText(plain)).toBeNull();
    expect(quantityCeiling(plain)).toBe(7);
  });

  it('counts 全选 over the available rows only', () => {
    const list = cartListFixture([
      cartItemFixture(),
      cartItemFixture({ id: '502', isSelected: false }),
      cartItemFixture({ id: '503', available: false, state: 'off_shelf', isSelected: true }),
    ]);
    expect(selectionOf(list)).toEqual({ all: false, some: true, ids: ['501'] });
    expect(couponLines(list)).toEqual([{ productId: '12', amount: '118.00' }]);
    const none = cartListFixture([cartItemFixture({ isSelected: false })]);
    expect(couponLines(none)).toBeNull();
  });

  it('hints the best usable coupon, or what is missing for the nearest one', () => {
    const lines = [{ amount: '118.00' }];
    const usable: ApplicableCoupons = {
      subtotal: '118.00',
      items: [
        {
          coupon: userCoupon('99.00', '10.00'),
          usable: true,
          discount: '10.00',
          eligibleLineIndexes: [0],
          reason: null,
        },
      ],
    };
    expect(couponHint(usable, lines)).toEqual({
      text: '结算时可用「满99减10」，省 ¥10.00',
      ready: true,
    });

    const short: ApplicableCoupons = {
      subtotal: '118.00',
      items: [
        {
          coupon: userCoupon('200.00', '30.00'),
          usable: false,
          discount: '0.00',
          eligibleLineIndexes: [0],
          reason: 'COUPON_MIN_SPEND_NOT_MET',
        },
        {
          coupon: userCoupon('150.00', '15.00'),
          usable: false,
          discount: '0.00',
          eligibleLineIndexes: [0],
          reason: 'COUPON_MIN_SPEND_NOT_MET',
        },
      ],
    };
    expect(couponHint(short, lines)).toEqual({
      text: '再买 ¥32.00 可用「满150减15」',
      ready: false,
    });
    expect(couponHint({ subtotal: '0.00', items: [] }, lines)).toBeNull();
    expect(couponHint(usable, null)).toBeNull();
  });
});
