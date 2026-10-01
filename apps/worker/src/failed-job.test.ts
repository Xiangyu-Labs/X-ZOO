import { describe, expect, it } from 'vitest';
import { DomainError, SummarizedError } from '@shop/core/kernel';
import { exhaustedSummary, NO_HANDLER_SUMMARY } from './failed-job';

describe('failed job summaries', () => {
  it('says what an error says in Chinese, and nothing of a raw message', () => {
    expect(exhaustedSummary(new SummarizedError('ETIMEDOUT', '连接数据库超时'), 3)).toBe(
      '连接数据库超时',
    );
    expect(exhaustedSummary(new DomainError('PAYMENT_NOT_CONFIGURED'), 3)).toBe(
      '支付尚未配置，请联系管理员',
    );
    expect(exhaustedSummary(new Error('connect ETIMEDOUT 10.0.0.5:5432'), 3)).toBe(
      '重试 3 次后仍然失败，请联系技术人员查看服务器日志',
    );
    expect(exhaustedSummary('boom', 1)).not.toContain('boom');
  });

  it('reads as Chinese when no handler is deployed', () => {
    expect(NO_HANDLER_SUMMARY).not.toMatch(/[A-Za-z]/);
  });
});
