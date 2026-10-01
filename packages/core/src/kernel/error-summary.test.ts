import { describe, expect, it } from 'vitest';
import { SummarizedError, summaryOf } from './error-summary';
import { DomainError } from './errors';

describe('summaryOf', () => {
  it('reads the summary an error carries, and a DomainError’s registry message', () => {
    expect(summaryOf(new SummarizedError('sms E1 boom', '短信发送失败'))).toBe('短信发送失败');
    expect(summaryOf(new DomainError('PAYMENT_NOT_CONFIGURED'))).toBe('支付尚未配置，请联系管理员');
  });

  it('says nothing for an error whose message may be raw', () => {
    expect(summaryOf(new Error('ECONNRESET'))).toBeNull();
    expect(summaryOf('boom')).toBeNull();
    // INTERNAL's message is free text a caller may fill with errmsg.
    expect(summaryOf(new DomainError('INTERNAL', { message: 'x: 40001 invalid' }))).toBeNull();
  });
});
