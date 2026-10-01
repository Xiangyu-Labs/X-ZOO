import { describe, expect, it } from 'vitest';
import { invoiceableAmount, isInvoiceRequestable } from './order.invoice.service';

const paid = {
  status: 'paid',
  refundStatus: 'none',
  paidAt: new Date('2026-09-01T02:00:00Z'),
  paidAmount: '100.00',
  refundedAmount: '0.00',
};

describe('INVOICE-004 — 订单详情 offers 申请开票 exactly when the request would be accepted', () => {
  it('offers it on a paid order with nothing open', () => {
    expect(isInvoiceRequestable(paid, false)).toBe(true);
  });

  it('does not offer it while a request is 待开票 or 已开票', () => {
    expect(isInvoiceRequestable(paid, true)).toBe(false);
  });

  it('does not offer it before payment', () => {
    expect(
      isInvoiceRequestable(
        { ...paid, status: 'pending_payment', paidAt: null, paidAmount: null },
        false,
      ),
    ).toBe(false);
  });

  it('does not offer it once the order is refunded in full', () => {
    expect(
      isInvoiceRequestable({ ...paid, refundStatus: 'refunded', refundedAmount: '100.00' }, false),
    ).toBe(false);
    expect(isInvoiceRequestable({ ...paid, status: 'refunded' }, false)).toBe(false);
  });

  it('does not offer it on a ¥0 order: there is nothing to invoice', () => {
    expect(isInvoiceRequestable({ ...paid, paidAmount: '0.00' }, false)).toBe(false);
  });

  it('makes it out for what was paid less what came back', () => {
    expect(invoiceableAmount({ paidAmount: '100.00', refundedAmount: '30.50' }).toString()).toBe(
      '69.50',
    );
    expect(
      isInvoiceRequestable(
        { ...paid, refundStatus: 'partially_refunded', refundedAmount: '30.50' },
        false,
      ),
    ).toBe(true);
    expect(invoiceableAmount({ paidAmount: null, refundedAmount: '0.00' }).toString()).toBe('0.00');
  });
});
