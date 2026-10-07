import { describe, expect, it } from 'vitest';
import { aftersaleOpen } from './order.aftersale';

const receivedAt = new Date('2026-03-01T10:00:00+08:00');
const after = (days: number, ms = 0) => new Date(receivedAt.getTime() + days * 86_400_000 + ms);

describe('aftersaleOpen (REFUND-022)', () => {
  it('is open before the goods arrive, whatever the 售后期限', () => {
    for (const days of [0, 7]) {
      expect(aftersaleOpen({ status: 'paid', receivedAt: null }, days, after(100))).toBe(true);
      expect(aftersaleOpen({ status: 'shipped', receivedAt: null }, days, after(100))).toBe(true);
    }
  });

  it('with no 售后期限, is open while received and shut once completed', () => {
    expect(aftersaleOpen({ status: 'received', receivedAt }, 0, after(30))).toBe(true);
    expect(aftersaleOpen({ status: 'completed', receivedAt }, 0, after(1))).toBe(false);
  });

  it('runs 售后期限 days from 确认收货, through completion, to the millisecond', () => {
    expect(aftersaleOpen({ status: 'completed', receivedAt }, 7, after(7))).toBe(true);
    expect(aftersaleOpen({ status: 'completed', receivedAt }, 7, after(7, 1))).toBe(false);
    expect(aftersaleOpen({ status: 'received', receivedAt }, 7, after(6))).toBe(true);
    // The review window can outlast the 售后期: still received, already shut.
    expect(aftersaleOpen({ status: 'received', receivedAt }, 7, after(7, 1))).toBe(false);
  });

  it('is shut on an order with nothing to apply on', () => {
    for (const status of ['pending_payment', 'cancelled', 'refunded']) {
      expect(aftersaleOpen({ status, receivedAt }, 7, after(1))).toBe(false);
    }
    expect(aftersaleOpen({ status: 'completed', receivedAt: null }, 7, after(1))).toBe(false);
  });
});
