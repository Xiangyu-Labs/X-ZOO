import { describe, expect, it } from 'vitest';
import { windowOf } from './order.console.service';

/**
 * 近 30 天实付 above the order list is 交易统计's 支付金额 for the same window:
 * whole Shanghai days, `to` exclusive, today and the 29 days before by default.
 */
describe('the order console’s statistics window', () => {
  it('defaults to today and the 29 Shanghai days before it', () => {
    // 00:30 on 2 June in Shanghai.
    const window = windowOf(new Date('2026-06-01T16:30:00.000Z'), {});
    expect(window.to.toISOString()).toBe('2026-06-02T16:00:00.000Z');
    expect(window.from.toISOString()).toBe('2026-05-03T16:00:00.000Z');
  });

  it('includes the whole last day the caller names', () => {
    const window = windowOf(new Date('2026-06-10T00:00:00.000Z'), {
      from: '2026-06-01T00:00:00+08:00',
      to: '2026-06-03T23:59:59+08:00',
    });
    expect(window.from.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-06-03T16:00:00.000Z');
  });
});
