import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deviceIdentity, startFakeOaServer, type FakeOaServer } from './fake-oa-server';

/**
 * The fake `api.weixin.qq.com` refuses what WeChat refuses. Here: a
 * `wx.login()` or `getPhoneNumber` code is good exactly once.
 */

let oa: FakeOaServer;

beforeAll(async () => {
  oa = await startFakeOaServer();
});

afterAll(async () => {
  await oa?.close();
});

beforeEach(() => {
  oa.reset();
});

async function jscode2session(code: string, server = oa): Promise<Record<string, unknown>> {
  const url = new URL(`${server.url}/sns/jscode2session`);
  url.searchParams.set('appid', server.miniAppId);
  url.searchParams.set('secret', server.miniAppSecret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  return (await (await fetch(url)).json()) as Record<string, unknown>;
}

async function miniToken(server = oa): Promise<string> {
  const url = new URL(`${server.url}/cgi-bin/token`);
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', server.miniAppId);
  url.searchParams.set('secret', server.miniAppSecret);
  const body = (await (await fetch(url)).json()) as { access_token: string };
  return body.access_token;
}

async function phoneNumber(code: string, server = oa): Promise<Record<string, unknown>> {
  const token = await miniToken(server);
  const response = await fetch(
    `${server.url}/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    },
  );
  return (await response.json()) as Record<string, unknown>;
}

describe('mini-program codes are single-use', () => {
  it('redeems a wx.login() code once, then answers 40163', async () => {
    oa.setMiniCode('login-once', { openid: 'oMINI_once', unionid: 'uUNION_once' });

    expect(await jscode2session('login-once')).toMatchObject({
      openid: 'oMINI_once',
      unionid: 'uUNION_once',
    });
    expect(await jscode2session('login-once')).toEqual({
      errcode: 40163,
      errmsg: 'code been used',
    });
  });

  it('answers 40029 for a code it never issued', async () => {
    expect(await jscode2session('never-issued')).toEqual({
      errcode: 40029,
      errmsg: 'invalid code',
    });
  });

  it('redeems a getPhoneNumber code once, then answers 40163', async () => {
    oa.setPhoneCode('phone-once', { phone: '13800000000' });

    expect(await phoneNumber('phone-once')).toMatchObject({
      errcode: 0,
      phone_info: { purePhoneNumber: '13800000000' },
    });
    expect(await phoneNumber('phone-once')).toEqual({ errcode: 40163, errmsg: 'code been used' });
  });

  it('forgets spent codes on reset', async () => {
    oa.setMiniCode('login-reset', { openid: 'oMINI_reset' });
    await jscode2session('login-reset');
    oa.reset();
    expect(await jscode2session('login-reset')).toMatchObject({ errcode: 40029 });
  });
});

describe('device mode', () => {
  // A code the real WeChat handed a real phone: 32 characters of its alphabet.
  const PHONE_CODE = '0c3Xk2Ga1lHmXK0qTzFa1Aq9Nh1Xk2Gm';

  it('is off by default: a real phone code is 40029, as WeChat would never have issued it here', async () => {
    expect(oa.deviceMode).toBe(false);
    expect(await jscode2session(PHONE_CODE)).toMatchObject({ errcode: 40029 });
    expect(await phoneNumber(PHONE_CODE)).toMatchObject({ errcode: 40029 });
  });

  it('maps a well-formed code to the same fake openid every time, once per code', async () => {
    const device = await startFakeOaServer({ deviceMode: true });
    try {
      const first = await jscode2session(PHONE_CODE, device);
      expect(first).toMatchObject({ openid: deviceIdentity(true, 'login', PHONE_CODE) });
      expect(String(first['openid'])).toMatch(/^odev_[\w-]{23}$/);
      expect(await jscode2session(PHONE_CODE, device)).toMatchObject({ errcode: 40163 });

      const other = await jscode2session('1d4Yl3Hb2mInYL1rUzGb2Br0Oi2Yl3Hn', device);
      expect(other['openid']).not.toBe(first['openid']);

      const phone = await phoneNumber(PHONE_CODE, device);
      expect(phone).toMatchObject({ errcode: 0 });
      const info = phone['phone_info'] as { purePhoneNumber: string };
      expect(info.purePhoneNumber).toMatch(/^139\d{8}$/);
      expect(info.purePhoneNumber).toBe(deviceIdentity(true, 'phone', PHONE_CODE));
      expect(await phoneNumber(PHONE_CODE, device)).toMatchObject({ errcode: 40163 });
    } finally {
      await device.close();
    }
  });

  it('pins one shopper when asked, still refuses a malformed code, and lets a seeded code win', async () => {
    const device = await startFakeOaServer({
      deviceMode: { openid: 'odev_tester', phone: '13900000001' },
    });
    try {
      expect(await jscode2session(PHONE_CODE, device)).toMatchObject({ openid: 'odev_tester' });
      expect(await jscode2session('1d4Yl3Hb2mInYL1rUzGb2Br0Oi2Yl3Hn', device)).toMatchObject({
        openid: 'odev_tester',
      });
      expect(await phoneNumber(PHONE_CODE, device)).toMatchObject({
        phone_info: { purePhoneNumber: '13900000001' },
      });

      for (const bad of ['short', 'has space in it 0123', `${'x'.repeat(129)}`, '']) {
        expect(await jscode2session(bad, device), bad).toMatchObject({ errcode: 40029 });
      }

      device.setMiniCode('seeded-code-0123456789', { openid: 'oMINI_seeded' });
      expect(await jscode2session('seeded-code-0123456789', device)).toMatchObject({
        openid: 'oMINI_seeded',
      });
    } finally {
      await device.close();
    }
  });
});

describe('发货信息管理 (wxa/sec/order)', () => {
  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const token = await miniToken();
    const response = await fetch(`${oa.url}${path}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  const upload = (overrides: Record<string, unknown> = {}) => ({
    order_key: { order_number_type: 2, transaction_id: '4200000001' },
    logistics_type: 1,
    delivery_mode: 1,
    shipping_list: [{ tracking_no: 'YT1', express_company: 'YTO', item_desc: '商品×1' }],
    upload_time: '2026-06-01T08:00:00.000+08:00',
    payer: { openid: 'o-payer' },
    ...overrides,
  });

  it('takes a unified upload, then one different re-upload, then refuses', async () => {
    expect((await post('/wxa/sec/order/upload_shipping_info', upload())).errcode).toBe(0);
    expect(oa.tradeOrder('4200000001')?.orderState).toBe(2);
    expect((await post('/wxa/sec/order/upload_shipping_info', upload())).errcode).toBe(10060023);
    const fixed = upload({
      shipping_list: [{ tracking_no: 'YT2', express_company: 'YTO', item_desc: '商品×1' }],
    });
    expect((await post('/wxa/sec/order/upload_shipping_info', fixed)).errcode).toBe(0);
    const again = upload({
      shipping_list: [{ tracking_no: 'YT3', express_company: 'YTO', item_desc: '商品×1' }],
    });
    expect((await post('/wxa/sec/order/upload_shipping_info', again)).errcode).toBe(10060003);
  });

  it('refuses a split non-express delivery, and SF without a masked contact', async () => {
    const split = upload({ logistics_type: 3, delivery_mode: 2, is_all_delivered: false });
    expect((await post('/wxa/sec/order/upload_shipping_info', split)).errcode).toBe(10060006);
    const sf = upload({
      shipping_list: [{ tracking_no: 'SF1', express_company: 'SF', item_desc: '商品×1' }],
    });
    expect((await post('/wxa/sec/order/upload_shipping_info', sf)).errcode).toBe(47001);
    const masked = upload({
      shipping_list: [
        {
          tracking_no: 'SF1',
          express_company: 'SF',
          item_desc: '商品×1',
          contact: { receiver_contact: '138****8000' },
        },
      ],
    });
    expect((await post('/wxa/sec/order/upload_shipping_info', masked)).errcode).toBe(0);
  });

  it('marks all-delivered only on the split part that says so', async () => {
    const part = (no: string, all: boolean) =>
      upload({
        delivery_mode: 2,
        is_all_delivered: all,
        shipping_list: [{ tracking_no: no, express_company: 'YTO', item_desc: '商品×1' }],
      });
    expect((await post('/wxa/sec/order/upload_shipping_info', part('P1', false))).errcode).toBe(0);
    expect(oa.tradeOrder('4200000001')?.orderState).toBe(1);
    expect((await post('/wxa/sec/order/upload_shipping_info', part('P2', true))).errcode).toBe(0);
    expect(oa.tradeOrder('4200000001')?.orderState).toBe(2);
  });

  it('reports order_state, stores the jump path and answers is_trade_managed', async () => {
    expect((await post('/wxa/sec/order/get_order', { transaction_id: 'nope' })).errcode).toBe(
      10060001,
    );
    oa.setTradeOrderState('4200000009', 3);
    const got = await post('/wxa/sec/order/get_order', { transaction_id: '4200000009' });
    expect((got['order'] as { order_state: number }).order_state).toBe(3);
    expect((await post('/wxa/sec/order/set_msg_jump_path', { path: 'a/b?x=1' })).errcode).toBe(0);
    expect(oa.msgJumpPath).toBe('a/b?x=1');
    oa.behaviour.tradeManaged = false;
    const managed = await post('/wxa/sec/order/is_trade_managed', { appid: oa.miniAppId });
    expect(managed['is_trade_managed']).toBe(false);
  });
});

describe('内容安全 (msg_sec_check, media_check_async)', () => {
  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const token = await miniToken();
    const response = await fetch(`${oa.url}${path}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  const text = (content: string, openid = 'o-user') => ({ content, version: 2, scene: 2, openid });

  it('answers pass, review and risky by the configured words', async () => {
    expect((await post('/wxa/msg_sec_check', text('很好用')))['result']).toEqual({
      suggest: 'pass',
      label: 100,
    });
    expect((await post('/wxa/msg_sec_check', text('有点待定测试')))['result']).toEqual({
      suggest: 'review',
      label: 21000,
    });
    expect((await post('/wxa/msg_sec_check', text('违规测试内容')))['result']).toEqual({
      suggest: 'risky',
      label: 20002,
    });
    oa.behaviour.secCheckRiskyWords = ['别的词'];
    expect((await post('/wxa/msg_sec_check', text('违规测试内容')))['result']).toMatchObject({
      suggest: 'pass',
    });
  });

  it('requires an openid, and refuses every call while failSecCheck is set', async () => {
    expect((await post('/wxa/msg_sec_check', text('x', '')))['errcode']).toBe(40003);
    oa.behaviour.failSecCheck = { errcode: -1, errmsg: 'system error' };
    expect((await post('/wxa/msg_sec_check', text('x')))['errcode']).toBe(-1);
    expect((await post('/wxa/msg_sec_check', text('x')))['errcode']).toBe(-1);
  });

  it('records a media check, answers a unique trace id, and builds its verdict push', async () => {
    const body = {
      media_url: 'https://shop.example.com/a.png',
      media_type: 2,
      version: 2,
      scene: 1,
      openid: 'o-user',
    };
    const first = await post('/wxa/media_check_async', body);
    const second = await post('/wxa/media_check_async', body);
    expect(first['errcode']).toBe(0);
    expect(first['trace_id']).not.toBe(second['trace_id']);
    expect(oa.mediaChecks.map((check) => check.traceId)).toEqual([
      first['trace_id'],
      second['trace_id'],
    ]);
    const push = oa.mediaCheckPush(String(first['trace_id']), 'risky');
    expect(push).toMatchObject({
      Event: 'wxa_media_check',
      appid: oa.miniAppId,
      FromUserName: 'o-user',
      trace_id: first['trace_id'],
      result: { suggest: 'risky', label: 20002 },
    });

    oa.behaviour.failMediaCheck = { errcode: 45009, errmsg: 'reach max api daily quota limit' };
    expect((await post('/wxa/media_check_async', body))['errcode']).toBe(45009);
  });
});
