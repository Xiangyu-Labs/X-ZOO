import { describe, expect, it } from 'vitest';
import { paymentErrors } from '../payment/errors';
import { refundErrors } from './errors';

describe('an unknown gateway result, as the person reads it', () => {
  it('says what happens next, never just 「人工核对」', () => {
    for (const { message } of [
      refundErrors.REFUND_STATE_UNKNOWN,
      paymentErrors.PAYMENT_STATE_UNKNOWN,
    ]) {
      expect(message).not.toMatch(/请人工核对/);
      expect(message).toMatch(/[一-鿿]/);
    }
    expect(refundErrors.REFUND_STATE_UNKNOWN.message).toContain('系统会继续查询');
  });
});
