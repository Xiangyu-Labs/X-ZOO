import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMULATION_STORAGE_KEY,
  PRIVACY_STORAGE_KEY,
  emulatedUser,
  emulationPlatform,
  privacyGate,
} from './h5-mp-emulation';
import { agreePrivacy, disagreePrivacy, resetPrivacyForTest, usePrivacyPrompt } from './privacy';

const jsapi = {
  appId: 'wxmini',
  timeStamp: '1',
  nonceStr: 'n',
  package: 'prepay_id=wx1',
  signType: 'RSA' as const,
  paySign: 's',
};

function stubControl(answer: unknown) {
  const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(answer), { status: 200 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function bodyOf(mock: ReturnType<typeof stubControl>, call = 0): unknown {
  return JSON.parse(String(mock.mock.calls[call]?.[1].body));
}

describe('h5-mp-emulation platform', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('talks to the server as wechat-mini, same origin', () => {
    expect(emulationPlatform.api).toMatchObject({ baseUrl: '', clientPlatform: 'wechat-mini' });
  });

  it('asks the harness for a login code for the emulated WeChat user', async () => {
    window.localStorage.setItem(
      EMULATION_STORAGE_KEY,
      JSON.stringify({ openid: 'o_test', unionid: 'u_test', phone: '13900000001' }),
    );
    const fetchMock = stubControl({ code: 'minted' });

    await expect(emulationPlatform.login()).resolves.toBe('minted');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/__e2e/mini/login-code');
    expect(bodyOf(fetchMock)).toEqual({ openid: 'o_test', unionid: 'u_test' });
  });

  it('makes up a user and keeps it when the harness set none', () => {
    const first = emulatedUser();
    expect(first.openid).toMatch(/^o_emu_\d{16}$/);
    expect(first.phone).toMatch(/^139\d{8}$/);
    expect(emulatedUser()).toEqual(first);
  });

  it('settles the payment through the harness, or plays the shopper cancelling', async () => {
    window.localStorage.setItem(
      EMULATION_STORAGE_KEY,
      JSON.stringify({ openid: 'o', phone: '13900000002' }),
    );
    const fetchMock = stubControl({ ok: true });
    await expect(
      emulationPlatform.requestPayment({ outTradeNo: 'P9', params: jsapi }),
    ).resolves.toEqual({ kind: 'paid' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/__e2e/mini/request-payment');
    expect(bodyOf(fetchMock)).toEqual({ package: 'prepay_id=wx1' });

    window.localStorage.setItem(
      EMULATION_STORAGE_KEY,
      JSON.stringify({ openid: 'o', phone: '13900000002', payment: 'cancel' }),
    );
    await expect(
      emulationPlatform.requestPayment({ outTradeNo: 'P9', params: jsapi }),
    ).resolves.toEqual({ kind: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when the harness is not there', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('not found', { status: 404 }))),
    );
    await expect(emulationPlatform.login()).rejects.toThrow(/login-code 失败 \(404/);
  });

  it('answers the 确认收货 component as the test data says, confirming by default', async () => {
    const target = { transactionId: '4200' };
    const fetchMock = stubControl({ orderState: 3 });
    await expect(emulationPlatform.openOrderConfirm(target)).resolves.toEqual({
      kind: 'confirmed',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/__e2e/mini/confirm-receipt');
    expect(bodyOf(fetchMock)).toEqual(target);
    window.localStorage.setItem(
      EMULATION_STORAGE_KEY,
      JSON.stringify({ openid: 'o_test', phone: '13900000001', receipt: 'cancel' }),
    );
    await expect(emulationPlatform.openOrderConfirm(target)).resolves.toEqual({
      kind: 'cancelled',
    });
  });

  it('confirms silently: no callback, only the app back in the foreground', async () => {
    const target = { transactionId: '4200' };
    const fetchMock = stubControl({ orderState: 3 });
    window.localStorage.setItem(
      EMULATION_STORAGE_KEY,
      JSON.stringify({ openid: 'o_test', phone: '13900000001', receipt: 'confirm-silently' }),
    );
    const shown = vi.fn();
    window.addEventListener('visibilitychange', shown);
    let settled = false;
    void emulationPlatform.openOrderConfirm(target).then(() => (settled = true));
    await vi.waitFor(() => expect(shown).toHaveBeenCalledTimes(1));
    window.removeEventListener('visibilitychange', shown);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/__e2e/mini/confirm-receipt');
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  describe('privacy (onNeedPrivacyAuthorization, C04)', () => {
    const holdPhone = (privacy?: 'agreed' | 'undecided') =>
      window.localStorage.setItem(
        EMULATION_STORAGE_KEY,
        JSON.stringify({ openid: 'o', phone: '13900000003', ...(privacy ? { privacy } : {}) }),
      );
    afterEach(() => resetPrivacyForTest());

    it('never asks a user who has agreed (the default)', async () => {
      holdPhone();
      await expect(emulationPlatform.chooseAddress()).resolves.toMatchObject({ city: '广州市' });
      expect(usePrivacyPrompt.getState().open).toBe(false);
    });

    it('holds the first private call on the app’s sheet until 同意, then asks no more', async () => {
      holdPhone('undecided');
      const address = emulationPlatform.chooseAddress();
      await vi.waitFor(() =>
        expect(usePrivacyPrompt.getState()).toEqual({ open: true, purpose: '快速填写收货地址' }),
      );

      agreePrivacy();
      await expect(address).resolves.toMatchObject({ city: '广州市' });
      expect(window.localStorage.getItem(PRIVACY_STORAGE_KEY)).toBe('agreed');
      await expect(privacyGate('getPhoneNumber')).resolves.toBe(true);
      expect(usePrivacyPrompt.getState().open).toBe(false);
    });

    it('fails only the call the shopper refused, and asks again next time', async () => {
      holdPhone('undecided');
      const address = emulationPlatform.chooseAddress();
      await vi.waitFor(() => expect(usePrivacyPrompt.getState().open).toBe(true));
      disagreePrivacy();
      await expect(address).resolves.toBeNull();

      const pictures = emulationPlatform.chooseImages(1);
      await vi.waitFor(() =>
        expect(usePrivacyPrompt.getState()).toEqual({
          open: true,
          purpose: '上传评价图片、售后凭证、头像',
        }),
      );
      disagreePrivacy();
      await expect(pictures).rejects.toThrow(
        'chooseMedia:fail privacy permission is not authorized',
      );
      expect(window.localStorage.getItem(PRIVACY_STORAGE_KEY)).toBeNull();
    });
  });
});
