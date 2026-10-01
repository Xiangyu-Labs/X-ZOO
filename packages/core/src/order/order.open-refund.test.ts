import { describe, expect, it } from 'vitest';
import { IN_FLIGHT_STATUSES } from '../refund';
import { OPEN_REFUND_STATUSES } from './order.repo';

describe('售后中 on an order', () => {
  it('counts exactly the refund statuses the refund domain keeps in flight', () => {
    // The order domain cannot import the refund domain's list (refund imports
    // order), so it spells it out; this is what keeps the 退款中 tab, the
    // badge, the delete refusal and `hasOpenRefund` in step with the lines a
    // request holds.
    expect([...OPEN_REFUND_STATUSES].sort()).toEqual([...IN_FLIGHT_STATUSES].sort());
  });
});
