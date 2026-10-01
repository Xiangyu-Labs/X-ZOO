import { describe, expect, it } from 'vitest';
import { DomainError } from '../kernel/errors';
import { refundRefusalMessage } from './wechat.pay';

const refused = (code: string, message = '') =>
  new DomainError('PAYMENT_GATEWAY_REFUSED', { details: { code, message } });

describe('refundRefusalMessage', () => {
  it('tells staff what to do for the refusals the v3 refund API documents', () => {
    expect(refundRefusalMessage(refused('NOT_ENOUGH', '余额不足'))).toBe(
      '微信支付商户号余额不足，请到商户平台充值后重试',
    );
    expect(refundRefusalMessage(refused('USER_ACCOUNT_ABNORMAL'))).toContain('请线下退款');
    expect(refundRefusalMessage(refused('FREQUENCY_LIMITED'))).toBe('退款请求过于频繁，请稍后重试');
  });

  it("names the business rule an INVALID_REQUEST broke, in the gateway's own words", () => {
    expect(refundRefusalMessage(refused('INVALID_REQUEST', '申请退款金额超过订单可退金额'))).toBe(
      '微信支付不受理此退款：申请退款金额超过订单可退金额',
    );
    expect(refundRefusalMessage(refused('INVALID_REQUEST'))).toBe('微信支付不受理此退款');
  });

  it("keeps the error's own message for anything else", () => {
    const generic = refused('PARAM_ERROR', 'out_refund_no 格式错误');
    expect(refundRefusalMessage(generic)).toBe(generic.message);
    const unknown = new DomainError('PAYMENT_STATE_UNKNOWN', { details: { reason: 'transport' } });
    expect(refundRefusalMessage(unknown)).toBe(unknown.message);
  });
});
