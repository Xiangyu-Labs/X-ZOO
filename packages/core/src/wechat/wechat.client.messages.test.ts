import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { createWechatClient, resetWechatTokenFlight } from './wechat.client';
import { wechatConfig } from './wechat.config';

/**
 * What the client throws is read by people: a toast, the storefront, the
 * effects ledger's `last_error`. So it is Chinese, with WeChat's errcode as
 * （错误码 N）, and never WeChat's English errmsg or our request path — those
 * are in the log (AGENTS rule 1).
 */

const warn = vi.fn();
const noop = (): void => {};

function ctxWith(saved: Record<string, unknown> = {}): Ctx {
  const values = wechatConfig.schema.parse({
    oaAppId: 'wxoa',
    oaAppSecret: 'oa-secret',
    miniAppId: 'wxmini',
    miniAppSecret: 'mini-secret',
    ...saved,
  });
  return {
    clock: { now: () => new Date() },
    logger: { trace: noop, debug: noop, info: noop, warn, error: noop, fatal: noop },
    config: { get: async () => values },
    redis: { get: async () => null, set: async () => 'OK', del: async () => 1 },
  } as unknown as Ctx;
}

function answer(body: string, status = 200): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
}

async function thrown(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

beforeEach(() => {
  resetWechatTokenFlight();
  warn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what the WeChat client says when WeChat says no', () => {
  it('a refused token refresh names the cause and the errcode, and logs the errmsg', async () => {
    answer(JSON.stringify({ errcode: 40125, errmsg: 'invalid appsecret, rid: 66f1' }));
    const error = await thrown(createWechatClient(ctxWith()).accessToken('oa'));

    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('获取微信接口凭证失败：AppSecret 不正确（错误码 40125）');
    expect(error.details).toEqual({ errcode: 40125 });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ errcode: 40125, errmsg: 'invalid appsecret, rid: 66f1' }),
      'wechat refused',
    );
  });

  it('a refused mini-program login keeps the errcode in details for the sign-in adapter', async () => {
    answer(JSON.stringify({ errcode: 40029, errmsg: 'invalid code' }));
    const error = await thrown(createWechatClient(ctxWith()).miniCode2Session('c'));

    expect(error.message).toBe('小程序登录失败（错误码 40029）');
    expect(error.details).toEqual({ errcode: 40029 });
  });

  it('the OA code exchange and the profile read say the same way', async () => {
    answer(JSON.stringify({ errcode: 40163, errmsg: 'code been used' }));
    const exchange = await thrown(createWechatClient(ctxWith()).oaCodeExchange('c'));
    expect(exchange.message).toBe('微信授权失败（错误码 40163）');

    answer(JSON.stringify({ errcode: 40003, errmsg: 'invalid openid' }));
    const profile = await thrown(
      createWechatClient(ctxWith()).oaUserInfo({ accessToken: 't', openid: 'o' }),
    );
    expect(profile.message).toBe('获取微信用户信息失败（错误码 40003）');
  });

  it('a non-2xx answer gives the status, not the path', async () => {
    answer('{}', 502);
    const error = await thrown(createWechatClient(ctxWith()).miniCode2Session('c'));

    expect(error.message).toBe('微信接口暂时不可用（HTTP 502）');
    expect(warn).toHaveBeenCalledWith(
      { path: '/sns/jscode2session', status: 502 },
      'wechat api answered a non-2xx status',
    );
  });

  it('an answer that is not JSON says so without the path', async () => {
    answer('<html>gateway timeout</html>');
    const error = await thrown(createWechatClient(ctxWith()).miniCode2Session('c'));

    expect(error.message).toBe('微信接口返回的内容无法识别');
    expect(error.message).not.toContain('/sns');
  });

  it('an app with no credentials is a registered refusal staff can act on, not INTERNAL', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const blank = ctxWith({ oaAppSecret: '', miniAppSecret: '' });

    expect((await thrown(createWechatClient(blank).accessToken('oa'))).code).toBe(
      'WECHAT_OA_NOT_CONFIGURED',
    );
    expect((await thrown(createWechatClient(blank).miniCode2Session('c'))).code).toBe(
      'AUTH_WECHAT_NOT_CONFIGURED',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
