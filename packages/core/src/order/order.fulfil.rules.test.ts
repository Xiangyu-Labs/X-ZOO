import { describe, expect, it } from 'vitest';
import { Money } from '../kernel/money';
import {
  applyPlan,
  csvCell,
  csvDocument,
  csvRow,
  isManuallyShippable,
  outstandingOf,
  planShipment,
  reprice,
  rollUpFulfillment,
  type LineState,
} from './order.fulfil.rules';

/**
 * Fulfilment arithmetic, with no database anywhere near it.
 *
 * Three families of property live here, and each one guards a bug that is easy
 * to ship:
 *
 *  1. a ship plan never exceeds what is outstanding, and counts a refunded
 *     unit as settled rather than as something still owed;
 *  2. a repricing splits back to the exact total and never pushes a line below
 *     zero;
 *  3. every exported cell is inert — 收货人 `=cmd|...` does not execute when an
 *     operator opens the file.
 */

const yuan = (value: string) => Money.parse(value);

function line(over: Partial<LineState> & { orderItemId: number }): LineState {
  return {
    quantity: 1,
    shippedQuantity: 0,
    refundedQuantity: 0,
    productKind: 'physical',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// outstanding / shippable
// ---------------------------------------------------------------------------

describe('outstandingOf', () => {
  it('subtracts what shipped and what was refunded', () => {
    expect(outstandingOf(line({ orderItemId: 1, quantity: 5, shippedQuantity: 2 }))).toBe(3);
    expect(
      outstandingOf(line({ orderItemId: 1, quantity: 5, shippedQuantity: 2, refundedQuantity: 3 })),
    ).toBe(0);
  });

  it('never goes negative, however the two counters were written', () => {
    expect(
      outstandingOf(line({ orderItemId: 1, quantity: 2, shippedQuantity: 2, refundedQuantity: 2 })),
    ).toBe(0);
  });
});

describe('isManuallyShippable', () => {
  it('covers exactly the kinds a human dispatches', () => {
    expect(isManuallyShippable('physical')).toBe(true);
    expect(isManuallyShippable('virtual_manual')).toBe(true);
    expect(isManuallyShippable('virtual_card')).toBe(false);
    expect(isManuallyShippable('virtual_coupon')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planShipment
// ---------------------------------------------------------------------------

describe('planShipment with an empty body (一键发货)', () => {
  it('ships everything outstanding on the manual lines', () => {
    const lines = [
      line({ orderItemId: 1, quantity: 3, shippedQuantity: 1 }),
      line({ orderItemId: 2, quantity: 2, productKind: 'virtual_manual' }),
    ];
    expect(planShipment(lines, [])).toEqual({
      kind: 'ok',
      lines: [
        { orderItemId: 1, quantity: 2 },
        { orderItemId: 2, quantity: 2 },
      ],
    });
  });

  it('skips the lines that are already settled', () => {
    const lines = [
      line({ orderItemId: 1, quantity: 2, shippedQuantity: 2 }),
      line({ orderItemId: 2, quantity: 2, refundedQuantity: 2 }),
      line({ orderItemId: 3, quantity: 1 }),
    ];
    expect(planShipment(lines, [])).toEqual({
      kind: 'ok',
      lines: [{ orderItemId: 3, quantity: 1 }],
    });
  });

  it('says so when the only thing left is a card the paid hook already delivered', () => {
    const lines = [
      line({ orderItemId: 1, quantity: 1, shippedQuantity: 1 }),
      line({ orderItemId: 2, quantity: 1, productKind: 'virtual_card' }),
    ];
    expect(planShipment(lines, [])).toEqual({ kind: 'auto-delivered-only' });
  });

  it('says nothing is outstanding when every line is settled', () => {
    const lines = [
      line({ orderItemId: 1, quantity: 2, shippedQuantity: 2 }),
      line({ orderItemId: 2, quantity: 1, productKind: 'virtual_card', shippedQuantity: 1 }),
    ];
    expect(planShipment(lines, [])).toEqual({ kind: 'nothing-outstanding' });
  });
});

describe('planShipment with named lines', () => {
  const lines = [
    line({ orderItemId: 1, quantity: 5, shippedQuantity: 1 }),
    line({ orderItemId: 2, quantity: 2 }),
  ];

  it('takes the operator at their word when it fits', () => {
    expect(planShipment(lines, [{ orderItemId: 1, quantity: 2 }])).toEqual({
      kind: 'ok',
      lines: [{ orderItemId: 1, quantity: 2 }],
    });
  });

  it('adds two rows for the same line instead of letting one win', () => {
    expect(
      planShipment(lines, [
        { orderItemId: 1, quantity: 2 },
        { orderItemId: 1, quantity: 2 },
      ]),
    ).toEqual({ kind: 'ok', lines: [{ orderItemId: 1, quantity: 4 }] });
  });

  it('and refuses the pair when together they overshoot', () => {
    expect(
      planShipment(lines, [
        { orderItemId: 1, quantity: 3 },
        { orderItemId: 1, quantity: 3 },
      ]),
    ).toEqual({ kind: 'over-ship', orderItemId: 1, requested: 6, remaining: 4 });
  });

  it('refuses a quantity beyond what is outstanding, naming the remainder', () => {
    expect(planShipment(lines, [{ orderItemId: 1, quantity: 5 }])).toEqual({
      kind: 'over-ship',
      orderItemId: 1,
      requested: 5,
      remaining: 4,
    });
  });

  it('counts a refunded unit as settled rather than shippable', () => {
    const refunded = [line({ orderItemId: 1, quantity: 3, refundedQuantity: 2 })];
    expect(planShipment(refunded, [{ orderItemId: 1, quantity: 2 }])).toEqual({
      kind: 'over-ship',
      orderItemId: 1,
      requested: 2,
      remaining: 1,
    });
  });

  it('names every line that does not belong to the order', () => {
    expect(
      planShipment(lines, [
        { orderItemId: 1, quantity: 1 },
        { orderItemId: 99, quantity: 1 },
        { orderItemId: 98, quantity: 1 },
      ]),
    ).toEqual({ kind: 'unknown-lines', orderItemIds: [99, 98] });
  });

  it('refuses to hand-ship a card line', () => {
    const cards = [line({ orderItemId: 7, quantity: 1, productKind: 'virtual_card' })];
    expect(planShipment(cards, [{ orderItemId: 7, quantity: 1 }])).toEqual({
      kind: 'auto-delivered-only',
    });
  });

  it('treats a body of zeroes as nothing to do', () => {
    expect(planShipment(lines, [{ orderItemId: 1, quantity: 0 }])).toEqual({
      kind: 'nothing-outstanding',
    });
  });
});

// ---------------------------------------------------------------------------
// the roll-up
// ---------------------------------------------------------------------------

describe('rollUpFulfillment', () => {
  it('is unfulfilled before anything moves', () => {
    expect(rollUpFulfillment([line({ orderItemId: 1, quantity: 2 })])).toBe('unfulfilled');
  });

  it('is partially_fulfilled once one line has gone out', () => {
    expect(
      rollUpFulfillment([
        line({ orderItemId: 1, quantity: 2, shippedQuantity: 2 }),
        line({ orderItemId: 2, quantity: 2 }),
      ]),
    ).toBe('partially_fulfilled');
  });

  it('is fulfilled when every line is shipped', () => {
    expect(
      rollUpFulfillment([
        line({ orderItemId: 1, quantity: 2, shippedQuantity: 2 }),
        line({ orderItemId: 2, quantity: 1, shippedQuantity: 1 }),
      ]),
    ).toBe('fulfilled');
  });

  /** Otherwise 待发货 would never empty. */
  it('is fulfilled when the only unshipped unit was refunded', () => {
    expect(
      rollUpFulfillment([
        line({ orderItemId: 1, quantity: 2, shippedQuantity: 1, refundedQuantity: 1 }),
      ]),
    ).toBe('fulfilled');
  });

  it('is fulfilled when every line was refunded before anything shipped', () => {
    expect(rollUpFulfillment([line({ orderItemId: 1, quantity: 2, refundedQuantity: 2 })])).toBe(
      'fulfilled',
    );
  });

  it('calls an order with no lines unfulfilled rather than done', () => {
    expect(rollUpFulfillment([])).toBe('unfulfilled');
  });
});

describe('applyPlan', () => {
  it('previews exactly what the writes will leave behind', () => {
    const lines = [line({ orderItemId: 1, quantity: 3 }), line({ orderItemId: 2, quantity: 1 })];
    const plan = [{ orderItemId: 1, quantity: 3 }];
    expect(applyPlan(lines, plan).map((l) => l.shippedQuantity)).toEqual([3, 0]);
    // and leaves the input alone
    expect(lines.map((l) => l.shippedQuantity)).toEqual([0, 0]);
    expect(rollUpFulfillment(applyPlan(lines, plan))).toBe('partially_fulfilled');
  });
});

// ---------------------------------------------------------------------------
// 改价
// ---------------------------------------------------------------------------

describe('reprice', () => {
  const twoLines = [
    { orderItemId: 1, quantity: 1, unitPrice: yuan('60.00'), checkoutDiscount: Money.ZERO },
    { orderItemId: 2, quantity: 2, unitPrice: yuan('20.00'), checkoutDiscount: Money.ZERO },
  ];
  /** A 满 50 减 10 coupon scoped to the first product: all 10.00 sit on line 1. */
  const couponOnFirst = [
    { ...twoLines[0]!, checkoutDiscount: yuan('10.00') },
    { ...twoLines[1]!, checkoutDiscount: Money.ZERO },
  ];

  it('splits the new discount across the lines and sums back exactly', () => {
    const outcome = reprice({
      lines: twoLines,
      freightAmount: yuan('10.00'),
      operatorDiscount: yuan('10.00'),
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.couponDiscount.toString()).toBe('10.00');
    expect(Money.sum(outcome.lines.map((l) => l.discountAmount)).toString()).toBe('10.00');
    // 100.00 goods - 10.00 discount + 10.00 freight
    expect(outcome.payableAmount.toString()).toBe('100.00');
  });

  it('adds the operator discount to what the coupon already took', () => {
    const outcome = reprice({
      lines: couponOnFirst,
      freightAmount: Money.ZERO,
      operatorDiscount: yuan('5.00'),
    });
    if (outcome.kind !== 'ok') throw new Error(outcome.kind);
    expect(outcome.couponDiscount.toString()).toBe('15.00');
    expect(outcome.payableAmount.toString()).toBe('85.00');
  });

  it('ORDER-012 — keeps a scoped coupon on its own line and spreads only the operator’s discount', () => {
    const outcome = reprice({
      lines: couponOnFirst,
      freightAmount: Money.ZERO,
      operatorDiscount: yuan('9.00'),
    });
    if (outcome.kind !== 'ok') throw new Error(outcome.kind);
    // Left to pay per line before 改价: 50.00 and 40.00, so 9.00 splits 5.00 / 4.00.
    expect(outcome.lines.map((l) => l.discountAmount.toString())).toEqual(['15.00', '4.00']);
    expect(outcome.lines.map((l) => l.totalAmount.toString())).toEqual(['45.00', '36.00']);
  });

  it('ORDER-012 — a zero 改价 gives every line back exactly its checkout share', () => {
    const outcome = reprice({
      lines: couponOnFirst,
      freightAmount: Money.ZERO,
      operatorDiscount: Money.ZERO,
    });
    if (outcome.kind !== 'ok') throw new Error(outcome.kind);
    expect(outcome.lines.map((l) => l.discountAmount.toString())).toEqual(['10.00', '0.00']);
  });

  it('keeps every fen when the split does not divide evenly', () => {
    const outcome = reprice({
      lines: [
        { orderItemId: 1, quantity: 1, unitPrice: yuan('0.01'), checkoutDiscount: Money.ZERO },
        { orderItemId: 2, quantity: 1, unitPrice: yuan('0.01'), checkoutDiscount: Money.ZERO },
        { orderItemId: 3, quantity: 1, unitPrice: yuan('0.01'), checkoutDiscount: Money.ZERO },
      ],
      freightAmount: Money.ZERO,
      operatorDiscount: yuan('0.02'),
    });
    if (outcome.kind !== 'ok') throw new Error(outcome.kind);
    expect(Money.sum(outcome.lines.map((l) => l.discountAmount)).toString()).toBe('0.02');
    expect(Money.sum(outcome.lines.map((l) => l.totalAmount)).toString()).toBe('0.01');
  });

  it('never pushes a line below zero', () => {
    const outcome = reprice({
      lines: couponOnFirst,
      freightAmount: Money.ZERO,
      operatorDiscount: yuan('90.00'),
    });
    if (outcome.kind !== 'ok') throw new Error(outcome.kind);
    for (const l of outcome.lines) expect(l.totalAmount.fen).toBeGreaterThanOrEqual(0);
    expect(outcome.payableAmount.toString()).toBe('0.00');
  });

  it('refuses a discount past the goods total rather than clamping it silently', () => {
    const outcome = reprice({
      lines: couponOnFirst,
      freightAmount: Money.ZERO,
      operatorDiscount: yuan('1000.00'),
    });
    expect(outcome.kind).toBe('too-large');
    if (outcome.kind !== 'too-large') return;
    // The operator is told what would have fitted: 100.00 goods - 10.00 taken.
    expect(outcome.maximum.toString()).toBe('90.00');
  });

  it('leaves the freight where it was — 改价 discounts goods, not postage', () => {
    const outcome = reprice({
      lines: twoLines,
      freightAmount: yuan('12.34'),
      operatorDiscount: yuan('1.00'),
    });
    if (outcome.kind !== 'ok') throw new Error(outcome.kind);
    expect(outcome.freightAmount.toString()).toBe('12.34');
  });

  it('is a no-op for a zero discount', () => {
    const outcome = reprice({
      lines: twoLines,
      freightAmount: Money.ZERO,
      operatorDiscount: Money.ZERO,
    });
    if (outcome.kind !== 'ok') throw new Error(outcome.kind);
    expect(outcome.payableAmount.toString()).toBe('100.00');
    expect(outcome.lines.map((l) => l.totalAmount.toString())).toEqual(['60.00', '40.00']);
  });
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

describe('csvCell', () => {
  it('passes an ordinary cell through', () => {
    expect(csvCell('张三')).toBe('张三');
    expect(csvCell(42)).toBe('42');
  });

  it('writes an empty cell for null and undefined', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes a comma, a quote and a newline the RFC 4180 way', () => {
    expect(csvCell('杭州市, 浙江省')).toBe('"杭州市, 浙江省"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  /** CSV injection: a cell written straight through would run in Excel. */
  it('defuses a formula, whichever character opens it', () => {
    expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvCell('+1234')).toBe("'+1234");
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tTAB')).toBe("'\tTAB");
  });

  it('quotes a defused formula that also contains a comma', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
  });

  it('leaves a phone number that merely contains a dash alone', () => {
    expect(csvCell('0571-88888888')).toBe('0571-88888888');
  });
});

describe('csvRow and csvDocument', () => {
  it('ends every row with a newline', () => {
    expect(csvRow(['a', 'b'])).toBe('a,b\n');
  });

  it('writes the header then the rows', () => {
    expect(
      csvDocument(
        ['订单号', '收货人'],
        [
          ['NO1', '张三'],
          ['NO2', '=1+1'],
        ],
      ),
    ).toBe("订单号,收货人\nNO1,张三\nNO2,'=1+1\n");
  });

  it('writes a header-only document when there is nothing to export', () => {
    expect(csvDocument(['订单号'], [])).toBe('订单号\n');
  });
});
