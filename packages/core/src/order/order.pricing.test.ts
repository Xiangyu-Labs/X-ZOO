import { describe, expect, it } from 'vitest';
import { Money } from '../kernel/money';
import type { PriceAdjustment } from './ports';
import type { SkuForSale } from './catalog.port';
import {
  couponAdjustment,
  distribute,
  freightLineOf,
  goodsTotalOf,
  lineSubtotal,
  payableOf,
  splitAdjustments,
} from './order.pricing';

/**
 * The pricing pipeline, with no database anywhere near it.
 *
 * Two properties are asserted over and over, because everything downstream —
 * `orders.coupon_discount`, `order_items.discount_amount`, a later partial
 * refund — is built on them:
 *
 *  1. the per-line shares sum back to the total **exactly**;
 *  2. no line is ever discounted past its own subtotal.
 */

const yuan = (value: string) => Money.parse(value);
const lines = (...subtotals: string[]) =>
  subtotals.map((subtotal) => ({ subtotal: yuan(subtotal) }));

const discount = (source: string, amount: string, perLine?: string[]): PriceAdjustment => ({
  source,
  label: source,
  amount: yuan(amount),
  ...(perLine ? { perLine: perLine.map(yuan) } : {}),
});

describe('lineSubtotal', () => {
  it('multiplies by an integer quantity', () => {
    expect(lineSubtotal(yuan('19.99'), 3).toString()).toBe('59.97');
  });

  it('refuses a fractional quantity rather than rounding one', () => {
    expect(() => lineSubtotal(yuan('19.99'), 1.5)).toThrow(TypeError);
  });
});

describe('distribute', () => {
  it('splits by weight and keeps every fen', () => {
    const parts = distribute(
      yuan('10.00'),
      lines('60.00', '30.00', '10.00').map((l) => l.subtotal),
    );
    expect(parts.map(String)).toEqual(['6.00', '3.00', '1.00']);
    expect(Money.sum(parts).toString()).toBe('10.00');
  });

  it('gives the leftover fen to the largest remainder, deterministically', () => {
    const parts = distribute(yuan('10.00'), [yuan('1.00'), yuan('1.00'), yuan('1.00')]);
    expect(parts.map(String)).toEqual(['1.00', '1.00', '1.00']);

    const three = distribute(yuan('0.10'), [yuan('1.00'), yuan('1.00'), yuan('1.00')]);
    expect(three.map(String)).toEqual(['0.04', '0.03', '0.03']);
    expect(Money.sum(three).toString()).toBe('0.10');
  });

  it('never exceeds a capacity, and moves the excess to a line with slack', () => {
    // 0.01 of capacity on the first line, 99.99 on the second: a naive
    // weighted split would still round a fen onto the first.
    const parts = distribute(yuan('50.00'), [yuan('0.01'), yuan('99.99')]);
    expect(parts[0]!.lte(yuan('0.01'))).toBe(true);
    expect(Money.sum(parts).toString()).toBe('50.00');
  });

  it('caps at the total capacity — a coupon worth more than the cart stops at the cart', () => {
    const parts = distribute(yuan('999.00'), [yuan('10.00'), yuan('5.00')]);
    expect(Money.sum(parts).toString()).toBe('15.00');
  });

  it('spreads evenly when every line is free', () => {
    const parts = distribute(yuan('0.00'), [Money.ZERO, Money.ZERO]);
    expect(parts.map(String)).toEqual(['0.00', '0.00']);
  });
});

describe('splitAdjustments', () => {
  it('applies each adjustment against what is left of every line', () => {
    const cart = lines('100.00', '100.00');
    const split = splitAdjustments(cart, [
      discount('a:one', '-20.00'),
      discount('b:two', '-10.00'),
    ]);

    expect(split.total.toString()).toBe('30.00');
    expect(Money.sum(split.perLine).toString()).toBe('30.00');
    expect(split.applied.map((a) => a.amount.toString())).toEqual(['-20.00', '-10.00']);
  });

  it("keeps each adjustment's own per-line share, which the order lines persist", () => {
    const cart = lines('88.00', '12.00');
    const split = splitAdjustments(cart, [
      discount('presale:activity-price', '-10.00', ['10.00', '0.00']),
      discount('coupon:discount', '-5.00'),
    ]);

    expect(split.applied.map((a) => a.perLine.map(String))).toEqual([
      ['-10.00', '0.00'],
      ['-4.33', '-0.67'],
    ]);
    for (const applied of split.applied) {
      expect(Money.sum(applied.perLine).eq(applied.amount)).toBe(true);
    }
    // Per line, the adjustments' shares add up to that line's discount.
    for (const [index, share] of split.perLine.entries()) {
      expect(
        Money.sum(split.applied.map((a) => a.perLine[index]!))
          .negate()
          .eq(share),
      ).toBe(true);
    }
  });

  it('honours a contributor-supplied per-line split and never leaks outside it', () => {
    const cart = lines('100.00', '100.00');
    const split = splitAdjustments(cart, [discount('x:scoped', '-30.00', ['30.00', '0.00'])]);

    expect(split.perLine.map(String)).toEqual(['30.00', '0.00']);
    expect(split.total.toString()).toBe('30.00');
  });

  it('stops at the goods total instead of producing a negative line', () => {
    const cart = lines('10.00', '5.00');
    const split = splitAdjustments(cart, [discount('x:huge', '-100.00')]);

    expect(split.total.toString()).toBe('15.00');
    for (const [index, share] of split.perLine.entries()) {
      expect(share.lte(cart[index]!.subtotal)).toBe(true);
    }
  });

  it('ignores a non-negative adjustment rather than turning it into a surcharge', () => {
    const split = splitAdjustments(lines('10.00'), [discount('x:surcharge', '5.00')]);
    expect(split.total.toString()).toBe('0.00');
    expect(split.applied).toHaveLength(0);
  });

  it('leaves an adjustment out of the panel when it could not move a fen', () => {
    const cart = lines('10.00');
    const split = splitAdjustments(cart, [
      discount('a:all', '-10.00'),
      discount('b:nothing', '-10.00'),
    ]);
    expect(split.total.toString()).toBe('10.00');
    expect(split.applied.map((a) => a.source)).toEqual(['a:all']);
  });

  it('adds the shares back to the total for an awkward three-way split', () => {
    const cart = lines('33.33', '33.33', '33.34');
    const split = splitAdjustments(cart, [discount('x:one', '-10.00')]);
    expect(Money.sum(split.perLine).eq(split.total)).toBe(true);
    expect(split.total.toString()).toBe('10.00');
  });
});

describe('couponAdjustment', () => {
  it('discounts only the lines inside the coupon scope', () => {
    const cart = lines('60.00', '40.00');
    const adjustment = couponAdjustment({
      label: '满 50 减 10',
      discount: yuan('10.00'),
      lines: cart,
      eligibleLineIndexes: [1],
    });

    expect(adjustment.perLine?.map(String)).toEqual(['0.00', '10.00']);
    const split = splitAdjustments(cart, [adjustment]);
    expect(split.perLine.map(String)).toEqual(['0.00', '10.00']);
  });

  it('is expressed as a negative amount, as the wire wants it', () => {
    const adjustment = couponAdjustment({
      label: '券',
      discount: yuan('5.00'),
      lines: lines('10.00'),
      eligibleLineIndexes: [0],
    });
    expect(adjustment.amount.toString()).toBe('-5.00');
  });
});

describe('payableOf', () => {
  it('is items + freight - discount', () => {
    expect(payableOf(yuan('120.00'), yuan('8.00'), yuan('10.00')).toString()).toBe('118.00');
  });

  it('floors at zero rather than owing the shopper money', () => {
    expect(payableOf(yuan('10.00'), yuan('0.00'), yuan('50.00')).toString()).toBe('0.00');
  });

  it('still charges freight when the goods are fully discounted', () => {
    expect(payableOf(yuan('10.00'), yuan('8.00'), yuan('10.00')).toString()).toBe('8.00');
  });
});

describe('goodsTotalOf', () => {
  it('adds the line subtotals', () => {
    expect(goodsTotalOf(lines('1.01', '2.02', '3.03')).toString()).toBe('6.06');
  });
});

// ---------------------------------------------------------------------------
// freight
// ---------------------------------------------------------------------------

function sku(overrides: Partial<SkuForSale> = {}): SkuForSale {
  return {
    skuId: 1,
    productId: 10,
    productName: '测试商品',
    productImageUrl: '',
    productKind: 'physical',
    onSale: true,
    deleted: false,
    skuCode: 'SKU-1',
    specText: '',
    specValues: {},
    skuImageUrl: null,
    unitName: null,
    barCode: null,
    unitPrice: '10.00',
    originalUnitPrice: null,
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

describe('freightLineOf', () => {
  it('converts kilograms to grams and cubic metres to cubic centimetres, per line', () => {
    const line = freightLineOf({
      sku: sku({
        weight: '1.500',
        volume: '0.0025',
        freightMode: 'template',
        shippingTemplateId: 7,
      }),
      quantity: 2,
      subtotal: yuan('20.00'),
    });

    expect(line).toEqual({
      skuId: 1,
      quantity: 2,
      freightMode: 'template',
      fixedFreightFen: 0,
      freightTemplateId: 7,
      weight: 3000,
      volume: 5000,
      amountFen: 2000,
    });
  });

  it('treats a missing measurement as zero rather than NaN', () => {
    const line = freightLineOf({ sku: sku(), quantity: 1, subtotal: yuan('1.00') });
    expect(line.weight).toBe(0);
    expect(line.volume).toBe(0);
  });

  /**
   * A free line and a fixed-postage line both carry `shippingTemplateId: null`,
   * so the template id alone cannot tell the port which one it is looking at —
   * and they price differently. Carrying the mode on the line is what spares
   * the `FreightPort` re-reading the skus that checkout has just read, once per
   * quote.
   */
  it('carries the freight mode so the port never has to re-read the sku', () => {
    expect(freightLineOf({ sku: sku(), quantity: 1, subtotal: yuan('1.00') })).toMatchObject({
      freightMode: 'free',
      fixedFreightFen: 0,
      freightTemplateId: null,
    });

    expect(
      freightLineOf({
        sku: sku({ freightMode: 'fixed', fixedFreight: '8.50' }),
        quantity: 3,
        subtotal: yuan('30.00'),
      }),
    ).toMatchObject({ freightMode: 'fixed', fixedFreightFen: 850, freightTemplateId: null });
  });

  it('reads a fixed postage of zero, and a missing one, as no postage', () => {
    expect(
      freightLineOf({
        sku: sku({ freightMode: 'fixed', fixedFreight: null }),
        quantity: 1,
        subtotal: yuan('1.00'),
      }).fixedFreightFen,
    ).toBe(0);
  });

  it('ignores a stray fixed postage on a line that is not charged one', () => {
    // `postage` can stay filled in after an operator switches a product to a
    // template; charging it anyway is the 「改了模板还在收固定运费」 bug.
    expect(
      freightLineOf({
        sku: sku({ freightMode: 'template', fixedFreight: '8.50', shippingTemplateId: 7 }),
        quantity: 1,
        subtotal: yuan('1.00'),
      }).fixedFreightFen,
    ).toBe(0);
  });
});
