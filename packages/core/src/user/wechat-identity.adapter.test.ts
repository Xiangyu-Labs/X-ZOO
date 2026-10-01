import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import type { WechatCoreClient } from '../wechat';

const client = {
  miniCode2Session: vi.fn(),
  oaCodeExchange: vi.fn(),
  oaUserInfo: vi.fn(),
  call: vi.fn(),
};

vi.mock('../wechat', async () => ({
  getWechatClient: () => client as unknown as WechatCoreClient,
  wechatRefusal: (await import('../wechat/wechat.errcodes')).wechatRefusal,
}));

const { wechatIdentityAdapter } = await import('./wechat-identity.adapter');
const warn = vi.fn();
const ctx = { logger: { warn } } as unknown as Ctx;

const wechatFailure = (errcode: number) =>
  new DomainError('INTERNAL', { message: `x: ${errcode}`, details: { errcode } });

beforeEach(() => {
  vi.resetAllMocks();
});

describe('wechatIdentityAdapter', () => {
  it('turns a spent mini-program code into AUTH_WECHAT_CODE_INVALID', async () => {
    client.miniCode2Session.mockRejectedValue(wechatFailure(40163));
    await expect(wechatIdentityAdapter.miniCodeToSession(ctx, 'used')).rejects.toMatchObject({
      code: 'AUTH_WECHAT_CODE_INVALID',
    });
  });

  it('leaves a non-code failure alone — a bad secret is an incident, not a refusal', async () => {
    client.miniCode2Session.mockRejectedValue(wechatFailure(40125));
    await expect(wechatIdentityAdapter.miniCodeToSession(ctx, 'c')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('returns the session without inventing fields', async () => {
    client.miniCode2Session.mockResolvedValue({ openid: 'o1', sessionKey: 'k' });
    await expect(wechatIdentityAdapter.miniCodeToSession(ctx, 'c')).resolves.toEqual({
      openid: 'o1',
      unionid: undefined,
      sessionKey: 'k',
    });
  });

  it('reads the pure phone number through the generic mini call', async () => {
    client.call.mockResolvedValue({
      errcode: 0,
      phone_info: {
        phoneNumber: '+8613800138000',
        purePhoneNumber: '13800138000',
        countryCode: '86',
      },
    });
    await expect(wechatIdentityAdapter.miniPhoneNumber(ctx, 'p')).resolves.toEqual({
      phone: '13800138000',
      countryCode: '86',
    });
    expect(client.call).toHaveBeenCalledWith('mini', {
      method: 'POST',
      path: '/wxa/business/getuserphonenumber',
      body: { code: 'p' },
    });
  });

  it('refuses a phone envelope whose errcode says the code is invalid', async () => {
    client.call.mockResolvedValue({ errcode: 40029, errmsg: 'invalid code' });
    await expect(wechatIdentityAdapter.miniPhoneNumber(ctx, 'p')).rejects.toMatchObject({
      code: 'AUTH_WECHAT_CODE_INVALID',
    });
  });

  it('says any other phone refusal in Chinese with the errcode, and logs the errmsg', async () => {
    client.call.mockResolvedValue({ errcode: 40125, errmsg: 'invalid appsecret, rid: 1' });
    const error = await wechatIdentityAdapter.miniPhoneNumber(ctx, 'p').then(
      () => null,
      (caught: unknown) => caught as DomainError,
    );
    expect(error).toMatchObject({
      code: 'INTERNAL',
      message: '获取微信手机号失败：AppSecret 不正确（错误码 40125）',
      details: { errcode: 40125 },
    });
    expect(warn).toHaveBeenCalledWith(
      { errcode: 40125, errmsg: 'invalid appsecret, rid: 1' },
      'wechat getuserphonenumber refused',
    );
  });

  it('fetches the profile only when the OA scope granted it', async () => {
    client.oaCodeExchange.mockResolvedValue({
      openid: 'o2',
      accessToken: 't',
      refreshToken: '',
      expiresIn: 7200,
      scope: 'snsapi_base',
    });
    await expect(wechatIdentityAdapter.oaCodeToUser(ctx, 'c')).resolves.toEqual({
      openid: 'o2',
      unionid: undefined,
    });
    expect(client.oaUserInfo).not.toHaveBeenCalled();

    client.oaCodeExchange.mockResolvedValue({
      openid: 'o2',
      unionid: 'u2',
      accessToken: 't',
      refreshToken: '',
      expiresIn: 7200,
      scope: 'snsapi_userinfo',
    });
    client.oaUserInfo.mockResolvedValue({ openid: 'o2', nickname: '小明', avatarUrl: 'a' });
    await expect(wechatIdentityAdapter.oaCodeToUser(ctx, 'c')).resolves.toEqual({
      openid: 'o2',
      unionid: 'u2',
      nickname: '小明',
      avatarUrl: 'a',
    });
    expect(client.oaUserInfo).toHaveBeenCalledWith({ accessToken: 't', openid: 'o2' });
  });
});
