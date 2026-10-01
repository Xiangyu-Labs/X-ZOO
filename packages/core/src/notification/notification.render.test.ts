import { describe, expect, it } from 'vitest';
import {
  clampField,
  formatShopTime,
  legacyPlaceholdersIn,
  placeholdersIn,
  render,
  fitSubscribeField,
  renderFields,
  renderSubscribeFields,
  renderRoute,
  renderSmsParams,
  toTemplateData,
  WECHAT_FIELD_LIMIT,
} from './notification.render';
import { registerNotificationEvents } from './notification.registry';

describe('render', () => {
  const data = { orderNo: 'SO202602140001', amount: '99.00' };

  it('substitutes a placeholder', () => {
    expect(render('订单 {{orderNo}} 已支付 ¥{{amount}}', data)).toBe(
      '订单 SO202602140001 已支付 ¥99.00',
    );
  });

  it('accepts the spaces an operator leaves inside the braces', () => {
    expect(render('订单 {{ orderNo }}', data)).toBe('订单 SO202602140001');
  });

  it('renders an unknown placeholder as nothing, never as itself', () => {
    // A customer reading "您的订单 {{orderNo}} 已发货" learns the shop is broken.
    expect(render('您的订单 {{trackingNo}} 已发货', data)).toBe('您的订单  已发货');
  });

  it('leaves a single brace alone — stored wording may still use them', () => {
    expect(render('订单 {order_id}', data)).toBe('订单 {order_id}');
  });

  it('substitutes every occurrence, not just the first', () => {
    expect(render('{{orderNo}}/{{orderNo}}', data)).toBe('SO202602140001/SO202602140001');
  });

  it('does not re-render what a value itself contains', () => {
    // A product name containing `{{amount}}` must not be expanded, or a
    // customer-supplied string becomes a template injection.
    expect(render('{{orderNo}}', { orderNo: '{{amount}}', amount: '99.00' })).toBe('{{amount}}');
  });

  it('lists the placeholders a template uses, sorted and deduplicated', () => {
    expect(placeholdersIn('{{b}} {{a}} {{ b }}')).toEqual(['a', 'b']);
  });
});

describe('legacyPlaceholdersIn', () => {
  it('finds the old system’s {name} and {$name}, as written, once each', () => {
    expect(legacyPlaceholdersIn('{store_name}：订单 {$order_id} 已付款 {store_name}')).toEqual([
      { token: '{store_name}', name: 'store_name' },
      { token: '{$order_id}', name: 'order_id' },
    ]);
  });

  it('leaves a real placeholder, and braces that are not a name, alone', () => {
    expect(legacyPlaceholdersIn('订单 {{orderNo}} {{ amount }} {1} {} 价格{ 99 }')).toEqual([]);
  });
});

describe('clampField', () => {
  it('leaves a field WeChat accepts untouched', () => {
    expect(clampField('短')).toBe('短');
    expect(clampField('x'.repeat(WECHAT_FIELD_LIMIT))).toHaveLength(WECHAT_FIELD_LIMIT);
  });

  it('truncates rather than letting WeChat reject the whole message', () => {
    const out = clampField('x'.repeat(WECHAT_FIELD_LIMIT + 50));
    expect(out).toHaveLength(WECHAT_FIELD_LIMIT);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('renderFields', () => {
  const data = { orderNo: 'SO1', amount: '99.00' };

  it('produces the `{ field: { value } }` shape the template APIs want', () => {
    expect(renderFields({ character_string2: '{{orderNo}}', amount5: '{{amount}}' }, data)).toEqual(
      {
        character_string2: { value: 'SO1' },
        amount5: { value: '99.00' },
      },
    );
  });

  it('drops a field that rendered empty instead of sending ""', () => {
    // WeChat type-checks each field and fails the *whole* message (47003) on an
    // empty one, so one missing variable would lose the entire notification.
    expect(renderFields({ thing3: '{{missing}}', character_string2: '{{orderNo}}' }, data)).toEqual(
      {
        character_string2: { value: 'SO1' },
      },
    );
  });

  it('clamps a long value, so one long product name cannot lose the message', () => {
    const out = renderFields({ thing3: '{{name}}' }, { name: 'x'.repeat(400) });
    expect(out['thing3']?.value).toHaveLength(WECHAT_FIELD_LIMIT);
  });

  it('is empty for a template with no field map at all', () => {
    expect(renderFields(undefined, data)).toEqual({});
  });
});

describe('toTemplateData', () => {
  it('stringifies the scalars a payload carries', () => {
    expect(toTemplateData({ a: 'x', b: 2, c: true, d: 10n })).toEqual({
      a: 'x',
      b: '2',
      c: 'true',
      d: '10',
    });
  });

  it('turns null and undefined into the empty string, so the placeholder vanishes', () => {
    expect(toTemplateData({ a: null, b: undefined })).toEqual({ a: '', b: '' });
  });

  it('drops anything structured rather than printing [object Object]', () => {
    expect(toTemplateData({ a: { nested: 1 }, b: [1, 2], c: 'kept' })).toEqual({ c: 'kept' });
  });

  it('survives a payload that is not an object', () => {
    expect(toTemplateData(null)).toEqual({});
    expect(toTemplateData('string')).toEqual({});
  });
});

describe('formatShopTime', () => {
  it('reads an instant on the shop calendar, not the UTC one', () => {
    const lateUtc = new Date('2026-06-01T16:30:00.000Z');
    expect(formatShopTime(lateUtc, 'day')).toBe('2026-06-02');
    expect(formatShopTime(lateUtc, 'minute')).toBe('2026-06-02 00:30');
  });
});

describe('renderRoute', () => {
  it('fills the params in first, then validates the route — NOTIF-006', () => {
    expect(
      renderRoute({ route: 'order', params: { id: '{{orderId}}' } }, { orderId: '3001' }),
    ).toEqual({ route: 'order', params: { id: '3001' } });
  });

  it('answers null rather than a wrong destination when a variable is missing — NOTIF-006', () => {
    expect(renderRoute({ route: 'order', params: { id: '{{orderId}}' } }, {})).toBeNull();
    expect(
      renderRoute({ route: 'refund', params: { id: '{{refundId}}' } }, { refundId: 'x' }),
    ).toBeNull();
  });

  it('refuses at registration a route the catalogue does not let a message open — NOTIF-006', () => {
    const event = {
      code: 'test_bad_route',
      name: '测试',
      description: '测试',
      audience: 'user' as const,
      variables: [],
      channels: ['inApp' as const],
      defaults: { title: 't', body: 'b' },
    };
    expect(() =>
      registerNotificationEvents([{ ...event, route: { route: 'login', params: {} } }]),
    ).toThrow(/可通知的商城路由/);
    expect(() =>
      registerNotificationEvents([
        { ...event, route: { route: 'nowhere' as 'order', params: {} } },
      ]),
    ).toThrow(/可通知的商城路由/);
  });

  it('refuses at registration a web link on a customer event — NOTIF-006', () => {
    expect(() =>
      registerNotificationEvents([
        {
          code: 'test_user_link',
          name: '测试',
          description: '测试',
          audience: 'user',
          variables: [],
          channels: ['inApp'],
          defaults: { title: 't', body: 'b' },
          link: '/orders/1',
        },
      ]),
    ).toThrow(/用 route 而不是 link/);
  });
});

describe('NOTIF-010 — a subscribe-message value fits its field type', () => {
  it('cuts a thing to 20 characters with an ellipsis', () => {
    const long = '超长的商品名称'.repeat(5);
    const fitted = fitSubscribeField('thing3', long);
    expect([...fitted]).toHaveLength(20);
    expect(fitted.endsWith('…')).toBe(true);
    expect(fitSubscribeField('thing3', '短名称')).toBe('短名称');
  });

  it('keeps only digits, letters and ASCII symbols in a character_string, at most 32', () => {
    expect(fitSubscribeField('character_string2', '单号 SF-123 456')).toBe('SF-123456');
    expect(fitSubscribeField('character_string2', 'A'.repeat(40))).toHaveLength(32);
  });

  it('cuts a phrase to 5, a name to 10 characters (20 in ASCII), a symbol to 5', () => {
    expect(fitSubscribeField('phrase1', '待付款请尽快处理')).toBe('待付款请尽');
    expect(fitSubscribeField('name4', '一二三四五六七八九十十一')).toBe('一二三四五六七八九十');
    expect(fitSubscribeField('name4', 'a'.repeat(25))).toHaveLength(20);
    expect(fitSubscribeField('symbol7', '!!!!!!!')).toBe('!!!!!');
  });

  it('leaves the formatted types alone: amount, time, date', () => {
    expect(fitSubscribeField('amount5', '¥12345.60')).toBe('¥12345.60');
    expect(fitSubscribeField('time6', '2026-09-25 14:30')).toBe('2026-09-25 14:30');
    expect(fitSubscribeField('date2', '2026年9月25日')).toBe('2026年9月25日');
  });

  it('drops a field that fits to nothing rather than sending it empty', () => {
    expect(
      renderSubscribeFields(
        { character_string1: '{{name}}', thing2: '{{name}}' },
        { name: '张三' },
      ),
    ).toEqual({
      thing2: { value: '张三' },
    });
  });
});

describe('renderSmsParams', () => {
  const data = { orderId: '1001', orderNo: 'SO202602140001', amount: '99.00' };

  it('sends nothing for a template with no variables, never the payload', () => {
    expect(renderSmsParams(undefined, data)).toEqual([]);
    expect(renderSmsParams([], data)).toEqual([]);
  });

  it('renders the configured list in order, keeping an empty value in its slot', () => {
    expect(
      renderSmsParams(
        [
          { name: ' amount ', value: '{{amount}}元' },
          { value: '{{missing}}' },
          { name: 'no', value: '{{orderNo}}' },
        ],
        data,
      ),
    ).toEqual([
      { name: 'amount', value: '99.00元' },
      { name: '', value: '' },
      { name: 'no', value: 'SO202602140001' },
    ]);
  });
});
