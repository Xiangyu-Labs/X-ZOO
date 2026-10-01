import { describe, expect, it } from 'vitest';
import type { SkuForSale } from '../order';
import {
  capFor,
  isAvailable,
  quantityRuleOf,
  refuseQuantity,
  stateOf,
  MAX_CART_QUANTITY,
} from './cart.rules';

/**
 * The cart's availability rules, with nothing behind them.
 *
 * The case worth protecting is the first one: a row whose product is gone must
 * still come back, described, so the shopper can remove it. Dropped from the
 * response, it would leave people staring at a basket that had lost items.
 */

function sku(overrides: Partial<SkuForSale> = {}): SkuForSale {
  return {
    skuId: 21,
    productId: 11,
    productName: '有机三只松鼠坚果礼盒',
    productImageUrl: 'https://cdn.example.com/p/11.jpg',
    productKind: 'physical',
    onSale: true,
    deleted: false,
    skuCode: 'SKU-21',
    specText: '混合装|1000g',
    specValues: {},
    skuImageUrl: null,
    unitName: '盒',
    barCode: null,
    unitPrice: '60.00',
    originalUnitPrice: '88.00',
    costUnitPrice: null,
    stock: 10,
    weight: null,
    volume: null,
    freightMode: 'free',
    fixedFreight: null,
    shippingTemplateId: null,
    purchaseLimitMode: 'none',
    purchaseLimitQuantity: null,
    minPurchaseQuantity: 1,
    categoryIds: [],
    customForm: null,
    ...overrides,
  };
}

describe('stateOf', () => {
  it('is ok for a live, in-stock variant', () => {
    expect(stateOf(sku(), 2)).toBe('ok');
    expect(isAvailable('ok')).toBe(true);
  });

  it('describes a vanished variant rather than pretending it is not there', () => {
    expect(stateOf(undefined, 1)).toBe('deleted');
    expect(stateOf(sku({ deleted: true }), 1)).toBe('deleted');
    expect(isAvailable('deleted')).toBe(false);
  });

  it('separates off shelf from deleted, because the shopper can act on one', () => {
    expect(stateOf(sku({ onSale: false }), 1)).toBe('off_shelf');
  });

  it('is out of stock only when the row asks for more than there is', () => {
    expect(stateOf(sku({ stock: 2 }), 2)).toBe('ok');
    expect(stateOf(sku({ stock: 1 }), 2)).toBe('out_of_stock');
    expect(stateOf(sku({ stock: 0 }), 1)).toBe('out_of_stock');
  });

  it('refuses more than one card key per row', () => {
    expect(stateOf(sku({ productKind: 'virtual_card' }), 1)).toBe('ok');
    expect(stateOf(sku({ productKind: 'virtual_card' }), 2)).toBe('quantity_not_allowed');
  });

  it('reads the start quantity and the per-order limit off the product', () => {
    expect(stateOf(sku({ minPurchaseQuantity: 3 }), 2)).toBe('quantity_not_allowed');
    expect(stateOf(sku({ minPurchaseQuantity: 3 }), 3)).toBe('ok');
    expect(stateOf(sku({ purchaseLimitMode: 'per_order', purchaseLimitQuantity: 2 }), 3)).toBe(
      'quantity_not_allowed',
    );
  });

  it('CAT-014: counts a lifetime limit with what the order domain says was bought before', () => {
    const limited = sku({ purchaseLimitMode: 'lifetime', purchaseLimitQuantity: 3 });
    expect(stateOf(limited, 2)).toBe('ok');
    expect(stateOf(limited, 2, 1)).toBe('ok');
    expect(stateOf(limited, 2, 2)).toBe('quantity_not_allowed');
  });
});

describe('refuseQuantity', () => {
  it('lets a sane quantity through', () => {
    expect(refuseQuantity(sku(), 3)).toBeNull();
  });

  it('names the reason so the service can pick the error code', () => {
    expect(refuseQuantity(undefined, 1)?.code).toBe('CART_SKU_NOT_AVAILABLE');
    expect(refuseQuantity(sku({ onSale: false }), 1)?.code).toBe('CART_SKU_NOT_AVAILABLE');
    expect(refuseQuantity(sku({ productKind: 'virtual_card' }), 2)?.code).toBe(
      'CART_VIRTUAL_CARD_QUANTITY',
    );
    expect(refuseQuantity(sku({ stock: 1 }), 2)?.code).toBe('CART_OUT_OF_STOCK');
  });

  it('carries the number the storefront needs to show', () => {
    expect(refuseQuantity(sku({ minPurchaseQuantity: 5 }), 2)).toEqual({
      code: 'CART_BELOW_MIN_PURCHASE',
      details: { minimum: 5 },
    });
    expect(
      refuseQuantity(sku({ purchaseLimitMode: 'lifetime', purchaseLimitQuantity: 2 }), 3),
    ).toEqual({ code: 'CART_PURCHASE_LIMIT_REACHED', details: { limit: 2 } });
  });
});

describe('capFor', () => {
  it('is the shop-wide cap when the product sets no limit', () => {
    expect(capFor(sku())).toBe(MAX_CART_QUANTITY);
  });

  it('is the product limit when there is one', () => {
    expect(capFor(sku({ purchaseLimitMode: 'per_order', purchaseLimitQuantity: 3 }))).toBe(3);
  });

  it('never drops below one, whatever the data says', () => {
    expect(capFor(sku({ purchaseLimitMode: 'per_order', purchaseLimitQuantity: 0 }))).toBe(1);
  });

  it('is one for a card-key product, whatever limit the product carries', () => {
    // The stepper must not offer a quantity `refuseQuantity` refuses.
    expect(capFor(sku({ productKind: 'virtual_card' }))).toBe(1);
    expect(
      capFor(
        sku({
          productKind: 'virtual_card',
          purchaseLimitMode: 'per_order',
          purchaseLimitQuantity: 5,
        }),
      ),
    ).toBe(1);
  });
});

describe('quantityRuleOf — the rule a row runs into, for the storefront to name', () => {
  it('names the broken rule of a quantity_not_allowed row', () => {
    expect(quantityRuleOf(sku({ productKind: 'virtual_card' }), 2)).toEqual({
      kind: 'virtual_card',
      limit: 1,
      purchased: null,
    });
    expect(quantityRuleOf(sku({ minPurchaseQuantity: 3 }), 2)).toEqual({
      kind: 'min_purchase',
      limit: 3,
      purchased: null,
    });
    expect(
      quantityRuleOf(sku({ purchaseLimitMode: 'per_order', purchaseLimitQuantity: 2 }), 3),
    ).toEqual({ kind: 'per_order', limit: 2, purchased: null });
    expect(quantityRuleOf(sku(), 2)).toBeNull();
    expect(quantityRuleOf(undefined, 2)).toBeNull();
  });

  it('greys a row past a lifetime limit already used up, which checkout would refuse', () => {
    const limited = sku({ purchaseLimitMode: 'lifetime', purchaseLimitQuantity: 2 });
    expect(stateOf(limited, 1, 2)).toBe('quantity_not_allowed');
    expect(quantityRuleOf(limited, 1, 2)).toEqual({ kind: 'lifetime', limit: 2, purchased: 2 });
    // Within it: fine, and the limit comes along as a note.
    expect(stateOf(limited, 1, 1)).toBe('ok');
    expect(quantityRuleOf(limited, 1, 1)).toEqual({ kind: 'lifetime', limit: 2, purchased: 1 });
  });
});
