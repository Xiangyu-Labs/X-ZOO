import { describe, expect, it } from 'vitest';
import { channelsFromOutcome, readableError } from './notification.admin.service';
import { explainChannelReason } from './notification.send';
import { failureMessage } from './notification.service';

describe('channelsFromOutcome', () => {
  const all = ['inApp', 'wechatOa', 'wechatMini', 'sms'] as const;

  it('reads every supported channel off the fan-out’s outcome, in the registry’s order', () => {
    expect(
      channelsFromOutcome(all, {
        sent: ['inApp'],
        skipped: [
          { channel: 'sms', reason: 'no sms provider registered' },
          { channel: 'wechatMini', reason: 'wechatMini 43101: user refuse' },
        ],
        failed: [{ channel: 'wechatOa', reason: 'wechatOa 40001: invalid credential' }],
      }),
    ).toEqual([
      { channel: 'inApp', outcome: 'sent', note: null },
      {
        channel: 'wechatOa',
        outcome: 'failed',
        note: '发送失败：AppSecret 不正确，或已在公众平台重置（错误码 40001）',
      },
      {
        channel: 'wechatMini',
        outcome: 'skipped',
        note: '该会员没有订阅这条消息——小程序订阅消息要用户先在小程序里点过「允许」（错误码 43101）',
      },
      { channel: 'sms', outcome: 'skipped', note: '没有配置短信服务商（系统设置 → 短信）' },
    ]);
  });

  it('never shows the stored English or gateway text', () => {
    const channels = channelsFromOutcome(all, {
      sent: [],
      skipped: [{ channel: 'wechatOa', reason: 'wechatOa 43999: something new' }],
      failed: [
        { channel: 'sms', reason: 'sms isv.SOMETHING_NEW provider text' },
        { channel: 'wechatMini', reason: 'wechatMini 49999: something nobody has seen' },
        { channel: 'inApp', reason: 'connect ECONNREFUSED 127.0.0.1:5432' },
      ],
    });
    expect(channels).toEqual([
      { channel: 'inApp', outcome: 'failed', note: '发送失败：网络或对方服务暂时不可用，没能发出' },
      { channel: 'wechatOa', outcome: 'skipped', note: '微信拒收了这条消息（错误码 43999）' },
      { channel: 'wechatMini', outcome: 'failed', note: '发送失败：微信返回错误码 49999' },
      {
        channel: 'sms',
        outcome: 'failed',
        note: '发送失败：短信服务商拒绝发送（isv.SOMETHING_NEW）',
      },
    ]);
    // Only the gateway's code, in brackets at the end, for whoever they ask for help.
    for (const { note } of channels)
      expect(note?.replace(/（[^）]*）$/, '')).not.toMatch(/[A-Za-z]/);
  });

  it('calls a channel the outcome does not mention 未知, never 已发送', () => {
    expect(
      channelsFromOutcome(['inApp', 'sms'], { sent: ['inApp'], skipped: [], failed: [] }),
    ).toEqual([
      { channel: 'inApp', outcome: 'sent', note: null },
      { channel: 'sms', outcome: 'unknown', note: '发送时还没有这个渠道' },
    ]);
  });
});

describe('readableError (最后错误)', () => {
  it('reads the fan-out’s failure per channel, in Chinese', () => {
    const stored = failureMessage([
      { channel: 'wechatOa', reason: 'wechatOa 40001: invalid credential' },
      { channel: 'sms', reason: 'sms isv.BUSINESS_LIMIT_CONTROL 触发分钟级流控；Permits:1' },
      { channel: 'inApp', reason: 'in-app write failed' },
    ]);
    expect(readableError(stored)).toBe(
      [
        '公众号：AppSecret 不正确，或已在公众平台重置（错误码 40001）',
        // The provider's message contained a `；` of its own; it stays with SMS.
        '短信：该手机号收到的短信太多，被服务商限流（isv.BUSINESS_LIMIT_CONTROL）',
        '站内信：站内信没能写入（数据库暂时不可用）',
      ].join('；'),
    );
  });

  it('reads a row the previous release wrote the same way', () => {
    expect(readableError('通知发送失败：wechatMini fetch failed')).toBe(
      '小程序：网络或对方服务暂时不可用，没能发出',
    );
  });

  it('never passes on an error from outside the channels', () => {
    expect(readableError(null)).toBeNull();
    expect(readableError('no handler for notification/notification.send')).toBe(
      '发送程序没有部署，请联系技术人员',
    );
    // Five digits in a transport error are not a WeChat code.
    expect(readableError('通知发送失败：wechatOa getaddrinfo ENOTFOUND api 40003')).toBe(
      '公众号：网络或对方服务暂时不可用，没能发出',
    );
    expect(readableError('connect ECONNREFUSED 127.0.0.1:5432')).toBe(
      '发送程序出错，请联系技术人员查看服务日志',
    );
  });
});

describe('explainChannelReason', () => {
  // A WeChat code is explained in one place: a send refusal here, a token or
  // configuration one in `wechat.errcodes.ts`, which this falls back to.
  it('falls back to the token and configuration table, with the code', () => {
    expect(explainChannelReason('wechatOa 40001: invalid credential')).toBe(
      'AppSecret 不正确，或已在公众平台重置（错误码 40001）',
    );
    expect(explainChannelReason('wechatMini 43101: refused')).toContain('错误码 43101');
  });
});
