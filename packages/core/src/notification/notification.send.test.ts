import { describe, expect, it } from 'vitest';
import { DomainError } from '../kernel/errors';
import {
  explainFailure,
  explainSkip,
  failedChannelsInWords,
  outcomeOfThrown,
} from './notification.send';

/**
 * A channel that throws is a transport failure, a refused token or a missing
 * AppSecret. Only the first is 网络或对方服务暂时不可用.
 */
describe('outcomeOfThrown', () => {
  const refusedToken = (errcode: number) =>
    new DomainError('INTERNAL', {
      message: `获取微信接口凭证失败（错误码 ${errcode}）`,
      details: { errcode },
    });

  it('files a wrong AppSecret under its errcode, so 发送记录 says AppSecret and not the network', () => {
    const outcome = outcomeOfThrown('wechatOa', refusedToken(40125));
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(explainFailure(outcome.reason)).toBe('AppSecret 不正确（错误码 40125）');
    expect(failedChannelsInWords([{ channel: 'wechatOa', reason: outcome.reason }])).toBe(
      '公众号：AppSecret 不正确（错误码 40125）',
    );
  });

  it('says the IP whitelist for the mini-program channel too', () => {
    const outcome = outcomeOfThrown('wechatMini', refusedToken(40164));
    expect(outcome).toMatchObject({ kind: 'failed' });
    if (outcome.kind !== 'failed') return;
    expect(explainFailure(outcome.reason)).toContain('IP 白名单');
  });

  it('says a refused token with a code nobody wrote down as the code', () => {
    const outcome = outcomeOfThrown('wechatOa', refusedToken(65301));
    if (outcome.kind !== 'failed') throw new Error('expected failed');
    expect(explainFailure(outcome.reason)).toBe('微信返回错误码 65301');
  });

  it('skips an account with no AppID or AppSecret, which only the operator can fill in', () => {
    for (const code of ['WECHAT_OA_NOT_CONFIGURED', 'AUTH_WECHAT_NOT_CONFIGURED']) {
      const outcome = outcomeOfThrown('wechatOa', new DomainError(code));
      expect(outcome).toEqual({ kind: 'skipped', reason: 'wechat not configured' });
    }
    expect(explainSkip('wechat not configured')).toContain('AppSecret');
  });

  it('leaves a transport failure as the network, the case a retry fixes', () => {
    const down = new DomainError('INTERNAL', { message: '微信接口暂时不可用（HTTP 502）' });
    const outcome = outcomeOfThrown('wechatOa', down);
    if (outcome.kind !== 'failed') throw new Error('expected failed');
    expect(explainFailure(outcome.reason)).toBe('网络或对方服务暂时不可用，没能发出');
    const dns = outcomeOfThrown('sms', new TypeError('fetch failed'));
    expect(dns).toEqual({ kind: 'failed', reason: 'fetch failed' });
  });

  it('does not read an errcode off an SMS channel’s error', () => {
    const outcome = outcomeOfThrown('sms', refusedToken(40125));
    if (outcome.kind !== 'failed') throw new Error('expected failed');
    expect(outcome.reason).not.toMatch(/^sms 40125/);
  });
});
