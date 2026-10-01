import { describe, expect, it } from 'vitest';
import { checkoutShares } from './order.console.service';
import type { OrderItemRow } from './order.repo';

function line(
  unitPrice: string,
  discountAmount: string,
  adjustments?: { source: string; label: string; amount: string }[],
): OrderItemRow {
  return {
    unitPrice,
    quantity: 1,
    discountAmount,
    snapshot: { productName: 'x', ...(adjustments ? { adjustments } : {}) },
  } as unknown as OrderItemRow;
}

const coupon = (amount: string) => [{ source: 'coupon:scoped', label: '满 50 减 10', amount }];

describe('ORDER-012 — what checkout took off each line, without the last 改价', () => {
  it('is the line discount itself before any 改价', () => {
    const shares = checkoutShares([line('60.00', '10.00'), line('40.00', '0.00')], '0.00');
    expect(shares.map(String)).toEqual(['10.00', '0.00']);
  });

  it('reads each line’s own checkout adjustments after a 改价', () => {
    // A scoped 10.00 coupon on line 1, then a 9.00 改价 spread 5.00 / 4.00.
    const shares = checkoutShares(
      [line('60.00', '15.00', coupon('-10.00')), line('40.00', '4.00', [])],
      '9.00',
    );
    expect(shares.map(String)).toEqual(['10.00', '0.00']);
  });

  it('spreads it by subtotal for an order written before per-line adjustments were kept', () => {
    const shares = checkoutShares([line('60.00', '15.00'), line('40.00', '4.00')], '9.00');
    expect(shares.map(String)).toEqual(['6.00', '4.00']);
  });
});
