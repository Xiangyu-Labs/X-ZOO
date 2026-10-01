import { describe, expect, it } from 'vitest';
import { Money } from '../kernel/money';
import {
  buyerMayWithdraw,
  countsUnits,
  coversEverything,
  freightRefundable,
  IN_FLIGHT_STATUSES,
  isInFlight,
  lineRefundAmount,
  normalise,
  orderRefundStatus,
  shopperLogMessage,
  type LogLineInput,
  refundableLine,
  remainingCeiling,
  type RefundableLineInput,
} from './refund.rules';

/**
 * The refund arithmetic, without a database.
 *
 * Every case here is a way a shop gives back the wrong amount of money, and
 * most of them are one rounding decision apart from the right one. Taking the
 * amount from the *request* would let a crafted body ask for any number it
 * liked, so the service computes it and the request carries lines and
 * quantities only, which makes these functions the whole defence.
 */

const line = (over: Partial<RefundableLineInput> = {}): RefundableLineInput => ({
  orderItemId: 1,
  quantity: 3,
  refundedQuantity: 0,
  shippedQuantity: 0,
  totalAmount: '29.99',
  refundedAmount: '0.00',
  isOpen: false,
  ...over,
});

describe('lineRefundAmount — the awkward split', () => {
  /**
   * 29.99 over three units is 9.996667 each. Rounding gives 10.00 three times,
   * which is one fen more than the shop was ever paid; truncating gives 9.99
   * three times and leaves two fen stranded on a fully refunded line.
   * Allocation gives 10.00, 10.00, 9.99 and adds back up exactly.
   */
  it('allocates the remainder instead of rounding each unit', () => {
    expect(lineRefundAmount(line(), 1).toString()).toBe('10.00');
    expect(lineRefundAmount(line(), 2).toString()).toBe('20.00');
    expect(lineRefundAmount(line(), 3).toString()).toBe('29.99');
  });

  it('gives back everything that is left when every remaining unit is refunded', () => {
    const partial = line({ refundedQuantity: 1, refundedAmount: '10.00' });
    expect(lineRefundAmount(partial, 2).toString()).toBe('19.99');
  });

  it('adds up to the line total across a partial refund and the rest', () => {
    const first = lineRefundAmount(line(), 1);
    const rest = lineRefundAmount(
      line({ refundedQuantity: 1, refundedAmount: first.toString() }),
      2,
    );
    expect(first.add(rest).toString()).toBe('29.99');
  });

  it('never promises more than the line has left, whatever quantity is asked for', () => {
    const nearlyDone = line({ refundedQuantity: 2, refundedAmount: '20.00' });
    expect(lineRefundAmount(nearlyDone, 99).toString()).toBe('9.99');
  });

  it('answers zero for a line already refunded in full', () => {
    expect(
      lineRefundAmount(line({ refundedQuantity: 3, refundedAmount: '29.99' }), 1).toString(),
    ).toBe('0.00');
  });

  it('clamps rather than going negative when more was refunded than the line cost', () => {
    expect(lineRefundAmount(line({ refundedAmount: '40.00' }), 1).toString()).toBe('0.00');
  });
});

describe('refundableLine — what the apply screen may offer', () => {
  it('offers every unpaid-for unit of an untouched line', () => {
    const result = refundableLine(line());
    expect(result.refundableQuantity).toBe(3);
    expect(result.refundableAmount.toString()).toBe('29.99');
    expect(result.blockedReason).toBeNull();
  });

  it('blocks a line that is already inside another request', () => {
    const result = refundableLine(line({ isOpen: true }));
    expect(result.blockedReason).toBe('REFUND_ALREADY_OPEN');
    expect(result.refundableQuantity).toBe(0);
    expect(result.refundableAmount.toString()).toBe('0.00');
  });

  it('blocks a line with nothing left', () => {
    const result = refundableLine(line({ refundedQuantity: 3, refundedAmount: '29.99' }));
    expect(result.blockedReason).toBe('REFUND_LINE_INVALID');
  });

  it('offers a shipped line — dispatch is not a reason to refuse a refund', () => {
    // Shipping changes what happens to the *stock*, not whether money comes
    // back; the restock rule reads `shippedQuantity`, this one does not.
    expect(refundableLine(line({ shippedQuantity: 3 })).blockedReason).toBeNull();
  });
});

describe('freightRefundable', () => {
  it('returns freight only while nothing has shipped', () => {
    expect(freightRefundable('unfulfilled')).toBe(true);
    expect(freightRefundable('partially_fulfilled')).toBe(false);
    expect(freightRefundable('fulfilled')).toBe(false);
  });
});

describe('remainingCeiling — the sum of refunds never exceeds the payment', () => {
  it('subtracts what has been refunded and what is already spoken for', () => {
    expect(
      remainingCeiling({
        paidAmount: '100.00',
        refundedAmount: '30.00',
        openAmount: '20.00',
      }).toString(),
    ).toBe('50.00');
  });

  it('is zero, not negative, once everything is committed', () => {
    expect(
      remainingCeiling({
        paidAmount: '100.00',
        refundedAmount: '80.00',
        openAmount: '40.00',
      }).toString(),
    ).toBe('0.00');
  });

  it('treats an unpaid order as nothing to give back', () => {
    expect(
      remainingCeiling({ paidAmount: null, refundedAmount: '0.00', openAmount: '0' }).toString(),
    ).toBe('0.00');
  });

  it('survives the shape PostgreSQL prints a `sum(numeric)` in', () => {
    // `sum()` over no rows is `0`, and over `50` is `50` — neither has a point.
    expect(normalise('0')).toBe('0.00');
    expect(normalise('50')).toBe('50.00');
    expect(normalise('50.00')).toBe('50.00');
    expect(
      remainingCeiling({
        paidAmount: '100.00',
        refundedAmount: '0.00',
        openAmount: '0',
      }).toString(),
    ).toBe('100.00');
  });
});

describe('orderRefundStatus — the roll-up on the order', () => {
  const paid = Money.parse('100.00');

  it('is `refunded` once the whole payment is back', () => {
    expect(orderRefundStatus(Money.parse('100.00'), paid, false)).toBe('refunded');
    expect(orderRefundStatus(Money.parse('120.00'), paid, false)).toBe('refunded');
  });

  it('is `partially_refunded` while some money is back', () => {
    expect(orderRefundStatus(Money.parse('30.00'), paid, false)).toBe('partially_refunded');
    // Still partial even with another request open: money already moved is the
    // stronger fact, and 退款中 on a partly refunded order reads as a lie.
    expect(orderRefundStatus(Money.parse('30.00'), paid, true)).toBe('partially_refunded');
  });

  it('is `requested` when nothing has moved but something is in flight', () => {
    expect(orderRefundStatus(Money.ZERO, paid, true)).toBe('requested');
  });

  it('is `none` when nothing has moved and nothing is in flight', () => {
    expect(orderRefundStatus(Money.ZERO, paid, false)).toBe('none');
  });

  it('never calls a free order refunded', () => {
    // `0 >= 0` is true, so a zero-value order would otherwise read as fully
    // refunded the moment it was created.
    expect(orderRefundStatus(Money.ZERO, Money.ZERO, false)).toBe('none');
  });
});

describe('REFUND-016 — an order a coupon paid for in full has a way out', () => {
  it('rolls up by units when no money was collected', () => {
    const none = Money.ZERO;
    expect(orderRefundStatus(none, none, false, { ordered: 2, settled: 2 })).toBe('refunded');
    expect(orderRefundStatus(none, none, true, { ordered: 2, settled: 1 })).toBe(
      'partially_refunded',
    );
    expect(orderRefundStatus(none, none, true, { ordered: 2, settled: 0 })).toBe('requested');
    expect(orderRefundStatus(none, none, false, { ordered: 2, settled: 0 })).toBe('none');
  });

  it('lets money decide for an order that collected money, whatever the units say', () => {
    const paid = Money.parse('100.00');
    expect(orderRefundStatus(Money.ZERO, paid, false, { ordered: 2, settled: 2 })).toBe('none');
  });
});

describe('REFUND-015 — the units a request holds follow its status', () => {
  it('counts a 仅退款 from approval until it is closed, and a return only once paid', () => {
    expect(countsUnits('refund_only', 'applied')).toBe(false);
    for (const status of ['approved', 'processing', 'unknown', 'failed', 'succeeded'] as const) {
      expect(countsUnits('refund_only', status)).toBe(true);
    }
    expect(countsUnits('refund_only', 'cancelled')).toBe(false);
    expect(countsUnits('refund_only', 'rejected')).toBe(false);

    expect(countsUnits('return_and_refund', 'approved')).toBe(false);
    expect(countsUnits('return_and_refund', 'failed')).toBe(false);
    expect(countsUnits('return_and_refund', 'succeeded')).toBe(true);
  });
});

describe('REFUND-017 — a refused refund is still in flight', () => {
  it('holds its lines while the merchant can send it again', () => {
    expect(IN_FLIGHT_STATUSES).toContain('failed');
    expect(isInFlight('failed')).toBe(true);
    for (const status of ['rejected', 'cancelled', 'succeeded'] as const) {
      expect(isInFlight(status)).toBe(false);
    }
  });

  it('lets the shopper withdraw it until money can have moved, but never a refund the shop opened', () => {
    for (const status of ['applied', 'approved', 'failed'] as const) {
      expect(buyerMayWithdraw({ status, isAutomatic: false })).toBe(true);
      expect(buyerMayWithdraw({ status, isAutomatic: true })).toBe(false);
    }
    for (const status of ['processing', 'unknown', 'succeeded', 'rejected', 'cancelled'] as const) {
      expect(buyerMayWithdraw({ status, isAutomatic: false })).toBe(false);
    }
  });
});

describe('REFUND-018 — the freight goes with the rest of an unshipped order', () => {
  it('counts a line inside another open request as taken', () => {
    // Line A is in the first request; the second asks for all of line B.
    expect(
      coversEverything([
        { remaining: 1, asked: 0, held: true },
        { remaining: 1, asked: 1, held: false },
      ]),
    ).toBe(true);
  });

  it('does not carry the freight while a takeable unit is left behind', () => {
    expect(
      coversEverything([
        { remaining: 2, asked: 1, held: false },
        { remaining: 1, asked: 1, held: false },
      ]),
    ).toBe(false);
    expect(
      coversEverything([
        { remaining: 1, asked: 1, held: false },
        { remaining: 1, asked: 0, held: false },
      ]),
    ).toBe(false);
  });

  it('ignores a line already given back in full', () => {
    expect(
      coversEverything([
        { remaining: 0, asked: 0, held: false },
        { remaining: 1, asked: 1, held: false },
      ]),
    ).toBe(true);
  });
});

describe('REFUND-019 — the shopper reads fixed lines, never what the gateway said', () => {
  const refund = { amount: '50.00', reason: '不想要了' };
  const system = (over: Partial<LogLineInput>): LogLineInput => ({
    fromStatus: 'processing',
    toStatus: 'failed',
    message: '退款失败：ABNORMAL',
    operatorAdminId: null,
    operatorUserId: null,
    ...over,
  });

  it('replaces a system row with the fixed line for its status', () => {
    expect(shopperLogMessage(system({}), refund)).toBe('退款未完成，商家处理中');
    expect(
      shopperLogMessage(
        system({ toStatus: 'unknown', message: 'fetch failed: ECONNRESET' }),
        refund,
      ),
    ).toBe('退款处理中');
    expect(
      shopperLogMessage(system({ toStatus: 'succeeded', message: 'notify: SUCCESS' }), refund),
    ).toBe('退款成功，款项已原路退回');
    expect(
      shopperLogMessage(system({ toStatus: 'succeeded', message: null }), {
        ...refund,
        amount: '0.00',
      }),
    ).toBe('售后已完成');
  });

  it('leaves out a system row that did not move the status, such as a merchant-number mismatch', () => {
    expect(
      shopperLogMessage(
        system({
          fromStatus: 'processing',
          toStatus: 'processing',
          message: '退款通知商户号不符：通知 1900000109，退款单 1900000110',
        }),
        refund,
      ),
    ).toBeNull();
  });

  it('shows a system-opened refund its reason, and keeps what a person wrote', () => {
    expect(
      shopperLogMessage(
        system({ fromStatus: null, toStatus: 'approved', message: '拼团 9 未成团' }),
        { amount: '50.00', reason: '拼团未成团，系统自动退款' },
      ),
    ).toBe('拼团未成团，系统自动退款');
    expect(
      shopperLogMessage(
        system({
          fromStatus: 'applied',
          toStatus: 'rejected',
          message: '商家拒绝：超出售后期',
          operatorAdminId: 1,
        }),
        refund,
      ),
    ).toBe('商家拒绝：超出售后期');
  });
});
