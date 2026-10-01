import { describe, expect, it } from 'vitest';
import { channelProblems, describeRefusal, missingFields } from './notification.channels';

const USER = { channels: ['inApp', 'wechatOa', 'wechatMini', 'sms'] as const };
const ADMIN = { channels: ['inApp'] as const };

describe('missingFields', () => {
  it('names what each channel needs and does not have, blank text included', () => {
    expect(missingFields('inApp', { enabled: true, title: ' ', body: '正文' })).toEqual(['title']);
    expect(missingFields('sms', { enabled: true, templateCode: '' })).toEqual(['templateCode']);
    // A row written around the save may lack the key altogether.
    expect(missingFields('sms', { enabled: true } as never)).toEqual(['templateCode']);
    expect(missingFields('wechatMini', { enabled: true, templateKey: '1458' })).toEqual([
      'templateId',
      'fields',
    ]);
    expect(
      missingFields('wechatOa', {
        enabled: true,
        templateKey: '',
        templateId: 'TPL',
        fields: { first: '{{orderNo}}' },
      }),
    ).toEqual([]);
  });
});

describe('NOTIF-013 — a switch that is on and cannot send says so', () => {
  it('reports a switched-on channel that cannot send, in the operator’s words', () => {
    expect(
      channelProblems(USER, {
        inApp: { enabled: true, title: '已发货', body: '订单 {{orderNo}}' },
        wechatMini: { enabled: true, templateKey: '1458' },
        sms: { enabled: false, templateCode: '' },
      }),
    ).toEqual([
      {
        channel: 'wechatMini',
        kind: 'incomplete',
        missing: ['templateId', 'fields'],
        message: '已开启但无法发送：缺模板 ID、字段映射',
      },
    ]);
  });

  it('reports a channel the event cannot use at all, however complete', () => {
    expect(
      channelProblems(ADMIN, {
        inApp: { enabled: true, title: '新订单', body: '订单 {{orderNo}}' },
        sms: { enabled: true, templateCode: 'SMS_1' },
        wechatOa: { enabled: false, templateKey: '' },
      }),
    ).toEqual([
      {
        channel: 'sms',
        kind: 'notApplicable',
        missing: [],
        message: '已开启但无法发送：该通知不支持此渠道',
      },
    ]);
  });

  it('never counts a switched-off channel', () => {
    expect(
      channelProblems(USER, {
        inApp: { enabled: false, title: '', body: '' },
        wechatOa: { enabled: false, templateKey: '' },
      }),
    ).toEqual([]);
  });
});

describe('describeRefusal', () => {
  it('names every channel in the way and how to get past it', () => {
    const problems = channelProblems(USER, {
      wechatOa: { enabled: true, templateKey: '', fields: { first: 'x' } },
      wechatMini: { enabled: true, templateKey: '1458' },
    });
    expect(describeRefusal(problems)).toBe(
      '「公众号」已开启但无法发送：缺模板 ID；「小程序」已开启但无法发送：缺模板 ID、字段映射。请填写，或关闭这些渠道后再保存',
    );
    expect(
      describeRefusal(channelProblems(ADMIN, { sms: { enabled: true, templateCode: '' } })),
    ).toBe('「短信」已开启但无法发送：该通知不支持此渠道。请关闭该渠道后再保存');
  });
});
