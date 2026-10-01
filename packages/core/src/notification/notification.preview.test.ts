import { describe, expect, it } from 'vitest';
import type { NotificationEvent } from './notification.registry';
import { describeOutcome, explainPreview, subscribeFieldProblem } from './notification.preview';

const SHIPPED: NotificationEvent = {
  code: 'order_shipped',
  name: '订单发货通知',
  description: '',
  audience: 'user',
  variables: ['orderId', 'orderNo', 'company', 'trackingNo'],
  channels: ['inApp', 'wechatOa', 'wechatMini', 'sms'],
  defaults: { title: '您的订单已发货', body: '订单 {{orderNo}} 已发货' },
  route: { route: 'order', params: { id: '{{orderId}}' } },
};

const DATA = { orderId: '1001', orderNo: 'SO1', company: '顺丰速运', trackingNo: 'SF123' };

describe('explainPreview', () => {
  it('renders every supported channel through the send path', () => {
    const result = explainPreview({
      event: SHIPPED,
      origin: 'https://shop.example.com',
      smsProvider: 'tencent',
      data: DATA,
      channels: {
        inApp: { enabled: true, title: '', body: '{{orderNo}} 由 {{company}} 发出' },
        wechatOa: {
          enabled: true,
          templateKey: '',
          templateId: 'TPL',
          fields: { keyword1: '{{orderNo}}', keyword2: '{{trackingNo}}' },
          linkUrl: '/orders/{{orderId}}',
        },
        wechatMini: {
          enabled: true,
          templateKey: '',
          templateId: 'MINI',
          fields: { character_string1: '{{orderNo}}', thing2: '{{company}}' },
        },
        sms: { enabled: false, templateCode: '' },
      },
    });
    expect(result.inApp).toEqual({
      enabled: true,
      title: '您的订单已发货',
      content: 'SO1 由 顺丰速运 发出',
      opens: 'packages/order/detail/index?id=1001',
    });
    expect(result.wechatOa).toMatchObject({
      url: 'https://shop.example.com/orders/1001',
      fields: [
        { key: 'keyword1', value: 'SO1' },
        { key: 'keyword2', value: 'SF123' },
      ],
    });
    expect(result.wechatMini?.page).toBe('packages/order/detail/index?id=1001');
    expect(result.sms).toMatchObject({ enabled: false, templateCode: '', params: [] });
    // SMS is off, so its missing template code is not a warning.
    expect(result.warnings).toEqual([]);
  });

  it('says what the send would silently do', () => {
    const result = explainPreview({
      event: SHIPPED,
      origin: '',
      smsProvider: 'tencent',
      data: { ...DATA, trackingNo: '' },
      channels: {
        inApp: { enabled: true, title: '{{orderNo}}', body: '{{trackngNo}} 运单 {{trackingNo}}' },
        wechatOa: {
          enabled: true,
          templateKey: '',
          fields: { keyword1: '{{trackingNo}}' },
          linkUrl: '/orders/{{orderId}}',
        },
        wechatMini: {
          enabled: true,
          templateKey: '',
          templateId: 'MINI',
          fields: { thing2: '一'.repeat(21), character_string1: '订单 SO1' },
        },
      },
    });
    expect(result.warnings).toEqual([
      '{{trackngNo}} 不是这个通知的变量（用在：站内信正文），发出去会是空的',
      '示例数据里 {{trackingNo}} 为空（用在：站内信正文、公众号 keyword1），这一处会显示为空',
      '公众号：还没填模板 ID，不会发送',
      '公众号：跳转链接是相对路径，但站点设置里没有对外域名，发送时会去掉链接',
      '公众号字段 keyword1 渲染后为空，发送时会被去掉',
      '公众号：所有字段渲染后都为空，不会发送',
      '小程序字段 thing2：超过 20 个字（现在 21 个），微信会拒收整条消息（47003）',
      '小程序字段 character_string1：只能是字母、数字和符号，不能有汉字或空格，微信会拒收整条消息（47003）',
    ]);
  });

  it('NOTIF-014 — names an old {name} or {$name} placeholder, which would reach the reader as written', () => {
    const result = explainPreview({
      event: SHIPPED,
      origin: 'https://shop.example.com',
      smsProvider: 'tencent',
      data: DATA,
      channels: {
        inApp: {
          enabled: true,
          title: '{store_name}',
          body: '订单 {$order_id} 已由 {{company}} 发出',
        },
        wechatOa: {
          enabled: true,
          templateKey: '',
          templateId: 'TPL',
          fields: { first: '{store_name}提醒您', keyword1: '{{orderNo}}' },
        },
        // Switched off: its wording is not a warning until it is switched on.
        wechatMini: {
          enabled: false,
          templateKey: '',
          templateId: 'MINI',
          fields: { thing1: '{nickname}' },
        },
      },
    });
    expect(result.warnings).toEqual([
      '{store_name} 是旧系统的占位符写法，不会被替换，收到的人会原样看到（用在：站内信标题、公众号 first）；这个通知没有对应的变量，请删掉或改写',
      '{$order_id} 是旧系统的占位符写法，不会被替换，收到的人会原样看到（用在：站内信正文）；请改成 {{orderId}}',
    ]);
    expect(result.inApp?.content).toBe('订单 {$order_id} 已由 顺丰速运 发出');
  });

  it('gives an admin event only its in-app message, opening the admin path', () => {
    const result = explainPreview({
      event: {
        code: 'refund_requested',
        name: '退款申请',
        description: '',
        audience: 'admin',
        variables: ['orderId'],
        channels: ['inApp'],
        defaults: { title: '新的退款申请', body: '' },
        link: '/admin/orders/{{orderId}}',
      },
      origin: '',
      smsProvider: 'tencent',
      data: DATA,
      channels: { inApp: { enabled: true, title: '', body: '' } },
    });
    expect(result).toMatchObject({ wechatOa: null, wechatMini: null, sms: null });
    expect(result.inApp?.opens).toBe('/admin/orders/1001');
  });
});

describe('explainPreview — SMS', () => {
  const sms = (
    provider: 'none' | 'aliyun' | 'tencent',
    params: { name: string; value: string }[],
    data: Record<string, string> = DATA,
  ) =>
    explainPreview({
      event: SHIPPED,
      origin: '',
      smsProvider: provider,
      data,
      channels: { sms: { enabled: true, templateCode: '520269', params } },
    });

  it('shows a template with no variables sending none, and nothing to warn about', () => {
    const result = sms('tencent', []);
    expect(result.sms).toEqual({
      enabled: true,
      provider: 'tencent',
      templateCode: '520269',
      signName: null,
      params: [],
    });
    expect(result.warnings).toEqual([]);
  });

  it('shows Tencent its variables by position, and warns past 6 characters', () => {
    const result = sms(
      'tencent',
      [
        { name: '', value: '{{company}}' },
        { name: 'ignored', value: '{{orderNo}}' },
      ],
      { ...DATA, orderNo: 'SO202609240001' },
    );
    expect(result.sms?.params).toEqual([
      { key: '{1}', value: '顺丰速运' },
      { key: '{2}', value: 'SO202609240001' },
    ]);
    expect(result.warnings).toEqual([
      '短信变量 {2}「SO202609240001」有 14 个字，腾讯云限制验证码以外的变量最多 6 个字，会被拒收',
    ]);
  });

  it('shows Aliyun its variables by name, and warns about a missing or repeated one', () => {
    const result = sms('aliyun', [
      { name: 'order_id', value: '{{orderNo}}' },
      { name: '', value: '{{company}}' },
      { name: 'order_id', value: '{{trackingNo}}' },
    ]);
    expect(result.sms?.params).toEqual([
      { key: 'order_id', value: 'SO1' },
      { key: '第 2 个（未填变量名）', value: '顺丰速运' },
      { key: 'order_id', value: 'SF123' },
    ]);
    expect(result.warnings).toEqual([
      '短信第 2 个变量没填变量名，阿里云按变量名填模板，会发送失败',
      '短信变量名 order_id 重复了，阿里云只会收到最后一个',
    ]);
  });

  it('says an SMS goes nowhere without a provider, and audits its placeholders', () => {
    const result = sms('none', [{ name: '', value: '{{trackngNo}}' }]);
    expect(result.warnings).toEqual([
      '{{trackngNo}} 不是这个通知的变量（用在：短信变量 {1}），发出去会是空的',
      '短信：还没在「系统设置 → 短信设置」里选择服务商，不会发送',
      '短信变量 {1} 渲染后为空，服务商可能拒收',
    ]);
  });
});

describe('subscribeFieldProblem', () => {
  it('checks the value against the field type', () => {
    expect(subscribeFieldProblem('amount3', '199.00')).toBeNull();
    expect(subscribeFieldProblem('amount3', '¥199.00')).toBeNull();
    expect(subscribeFieldProblem('amount3', '一百')).toMatch(/金额格式/);
    expect(subscribeFieldProblem('phrase4', '已发货')).toBeNull();
    expect(subscribeFieldProblem('phrase4', '已经在路上了')).toMatch(/超过 5 个字/);
    expect(subscribeFieldProblem('time5', '随便')).toBeNull();
  });
});

describe('describeOutcome', () => {
  it('puts WeChat codes and skip reasons in the operator’s words', () => {
    expect(describeOutcome('wechatOa', { kind: 'sent' })).toEqual({
      outcome: 'sent',
      message: '已发送，请在微信里查收',
    });
    expect(
      describeOutcome('wechatMini', { kind: 'skipped', reason: 'wechatMini 43101: user refuse' }),
    ).toEqual({
      outcome: 'skipped',
      message:
        '没有发出：该会员没有订阅这条消息——小程序订阅消息要用户先在小程序里点过「允许」（错误码 43101）',
    });
    expect(
      describeOutcome('sms', { kind: 'skipped', reason: 'no sms provider registered' }),
    ).toEqual({ outcome: 'skipped', message: '没有发出：没有配置短信服务商（系统设置 → 短信）' });
    expect(describeOutcome('sms', { kind: 'skipped', reason: 'user has no phone' })).toEqual({
      outcome: 'skipped',
      message: '没有发出：该会员没有绑定手机号',
    });
  });

  it('puts an SMS provider’s refusal in Chinese, without its own message', () => {
    expect(
      describeOutcome('sms', {
        kind: 'failed',
        reason:
          'sms FailedOperation.TemplateParamSetNotMatchApprovedTemplate request content does not match',
      }).message,
    ).toBe(
      '发送失败：变量个数和审核通过的模板不一致：模板里有几个 {1}{2}…，这里就要按顺序填几个变量，没有变量就一个都不填（FailedOperation.TemplateParamSetNotMatchApprovedTemplate）',
    );
    expect(describeOutcome('sms', { kind: 'failed', reason: 'sms isv.X boom' }).message).toBe(
      '发送失败：短信服务商拒绝发送（isv.X）',
    );
  });

  it('shows no gateway text, thrown message or channel id, only Chinese and a WeChat code', () => {
    expect(describeOutcome('wechatOa', { kind: 'failed', reason: 'fetch failed' })).toEqual({
      outcome: 'failed',
      message: '发送失败，请联系技术人员查看服务器日志',
    });
    expect(
      describeOutcome('wechatOa', {
        kind: 'failed',
        reason: 'wechatOa 49999: something nobody has seen',
      }),
    ).toEqual({
      outcome: 'failed',
      message: '发送失败：微信返回错误码 49999，请联系技术人员查看服务器日志',
    });
    expect(
      describeOutcome('wechatOa', { kind: 'failed', reason: 'getaddrinfo ENOTFOUND api 40003' })
        .message,
    ).toBe('发送失败，请联系技术人员查看服务器日志');
    expect(describeOutcome('wechatMini', { kind: 'skipped', reason: 'something new' })).toEqual({
      outcome: 'skipped',
      message: '没有发出，请联系技术人员查看服务器日志',
    });
  });

  it('explains every skip reason the senders return', () => {
    for (const reason of [
      'channel disabled',
      'no template id',
      'no template code',
      'no user',
      'user has no oa openid',
      'user has no mini openid',
      'no rendered fields',
      'no sms provider registered',
      'user has no phone',
    ]) {
      expect(describeOutcome('sms', { kind: 'skipped', reason }).message).not.toMatch(/技术人员/);
    }
  });
});
