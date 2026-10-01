import { fireEvent, render, screen } from '@testing-library/react';
import Taro from '@tarojs/taro';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { isPrivacyRefusal, PRIVACY_UNDECLARED_PHONE } from './privacy';
import { platform } from './runtime';

const jsapi = {
  appId: 'wxmini',
  timeStamp: '1700000000',
  nonceStr: 'n',
  package: 'prepay_id=wx1',
  signType: 'RSA' as const,
  paySign: 'sig',
};

describe('weapp platform', () => {
  it('is wechat-mini over Taro.request', () => {
    expect(platform.kind).toBe('weapp');
    expect(platform.api.clientPlatform).toBe('wechat-mini');
  });

  it('returns the wx.login code', async () => {
    taroFake.loginCode = 'abc';
    await expect(platform.login()).resolves.toBe('abc');
  });

  it('passes the jsapi parameters to wx.requestPayment and maps its outcome', async () => {
    await expect(platform.requestPayment({ outTradeNo: 'P1', params: jsapi })).resolves.toEqual({
      kind: 'paid',
    });
    expect(taroFake.calls).toContainEqual({
      api: 'requestPayment',
      args: {
        timeStamp: '1700000000',
        nonceStr: 'n',
        package: 'prepay_id=wx1',
        signType: 'RSA',
        paySign: 'sig',
      },
    });

    taroFake.paymentError = 'requestPayment:fail cancel';
    await expect(platform.requestPayment({ outTradeNo: 'P1', params: jsapi })).resolves.toEqual({
      kind: 'cancelled',
    });

    taroFake.paymentError = 'requestPayment:fail 系统错误';
    await expect(platform.requestPayment({ outTradeNo: 'P1', params: jsapi })).resolves.toEqual({
      kind: 'failed',
      message: '支付没有完成，请稍后重试',
    });
  });

  it('reports the phone code, or a refusal, from the getPhoneNumber button', () => {
    const onResult = vi.fn();
    render(<platform.PhoneNumberButton onResult={onResult}>手机号</platform.PhoneNumberButton>);
    fireEvent.click(screen.getByRole('button', { name: '手机号' }));
    expect(onResult).toHaveBeenLastCalledWith({ ok: true, code: 'fake-phone-code' });

    taroFake.phoneNumberDetail = { errMsg: 'getPhoneNumber:fail user deny' };
    fireEvent.click(screen.getByRole('button', { name: '手机号' }));
    expect(onResult).toHaveBeenLastCalledWith({
      ok: false,
      reason: 'denied',
      message: '已取消授权',
    });

    // errno 112: the shop's 隐私保护指引 lacks 手机号 — not the shopper's refusal, and not English.
    taroFake.phoneNumberDetail = {
      errMsg: 'getPhoneNumber:fail api scope is not declared in the privacy agreement',
      errno: 112,
    };
    fireEvent.click(screen.getByRole('button', { name: '手机号' }));
    expect(onResult).toHaveBeenLastCalledWith({
      ok: false,
      reason: 'unavailable',
      message: PRIVACY_UNDECLARED_PHONE,
    });
    expect(isPrivacyRefusal(taroFake.phoneNumberDetail)).toBe(false);
    expect(
      isPrivacyRefusal({ errMsg: 'getPhoneNumber:fail privacy permission is not authorized' }),
    ).toBe(true);
  });

  describe("every failure reads as Chinese, never as WeChat's errMsg", () => {
    const chinese = (message: string) => {
      expect(message).toMatch(/[一-龥]/);
      expect(message).not.toMatch(/fail/i);
    };

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('requestPayment', async () => {
      taroFake.paymentError = 'requestPayment:fail invalid paySign';
      const outcome = await platform.requestPayment({ outTradeNo: 'P1', params: jsapi });
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') chinese(outcome.message);
      // The raw text still goes somewhere a developer can read it.
      expect(console.warn).toHaveBeenCalledWith(
        '支付没有完成，请稍后重试',
        'requestPayment:fail invalid paySign',
      );
    });

    it('openBusinessView', async () => {
      taroFake.businessViewStatus = 'fail';
      const settled = await platform.openOrderConfirm({ transactionId: '4200' });
      if (settled.kind === 'failed') chinese(settled.message);

      vi.spyOn(Taro, 'openBusinessView').mockRejectedValueOnce({
        errMsg: 'openBusinessView:fail system error',
      });
      const thrown = await platform.openOrderConfirm({ transactionId: '4200' });
      expect(thrown).toEqual({ kind: 'failed', message: '确认收货失败，请稍后重试' });
    });

    it('the phone-number button', () => {
      const onResult = vi.fn();
      render(<platform.PhoneNumberButton onResult={onResult}>手机号</platform.PhoneNumberButton>);
      taroFake.phoneNumberDetail = { errMsg: 'getPhoneNumber:fail system error' };
      fireEvent.click(screen.getByRole('button', { name: '手机号' }));
      expect(onResult).toHaveBeenLastCalledWith({
        ok: false,
        reason: 'failed',
        message: '暂时无法获取手机号，请使用短信验证码',
      });
      for (const detail of [
        { errMsg: 'getPhoneNumber:fail user deny' },
        { errMsg: 'getPhoneNumber:fail', errno: 112 },
        { errMsg: 'getPhoneNumber:fail', errno: 1400001 },
        { errMsg: 'getPhoneNumber:fail system error' },
      ]) {
        taroFake.phoneNumberDetail = detail;
        fireEvent.click(screen.getByRole('button', { name: '手机号' }));
        chinese((onResult.mock.lastCall?.[0] as { message: string }).message);
      }
    });

    it('the avatar button', () => {
      const onResult = vi.fn();
      render(
        <platform.AvatarButton label="更换头像" onResult={onResult}>
          头像
        </platform.AvatarButton>,
      );
      const tap = (detail: { errMsg: string }) => {
        taroFake.avatarDetail = detail;
        fireEvent.click(screen.getByRole('button', { name: '更换头像' }));
        return (onResult.mock.lastCall?.[0] as { message: string }).message;
      };
      expect(tap({ errMsg: 'chooseAvatar:fail cancel' })).toBe('');
      expect(tap({ errMsg: 'chooseAvatar:fail privacy permission is not authorized' })).toBe(
        '未同意隐私保护指引，无法设置头像',
      );
      chinese(tap({ errMsg: 'chooseAvatar:fail system error' }));
      chinese(tap({ errMsg: '' }));
    });
  });

  it("opens WeChat's 确认收货 component with its own keys and maps how it ended", async () => {
    await expect(platform.openOrderConfirm({ transactionId: '4200' })).resolves.toEqual({
      kind: 'confirmed',
    });
    expect(taroFake.calls).toContainEqual({
      api: 'openBusinessView',
      args: { businessType: 'weappOrderConfirm', extraData: { transaction_id: '4200' } },
    });
    await platform.openOrderConfirm({ merchantId: 'm1', merchantTradeNo: 'P1' });
    expect(taroFake.calls.at(-1)?.args).toEqual({
      businessType: 'weappOrderConfirm',
      extraData: { merchant_id: 'm1', merchant_trade_no: 'P1' },
    });

    taroFake.businessViewStatus = 'cancel';
    await expect(platform.openOrderConfirm({ transactionId: '4200' })).resolves.toEqual({
      kind: 'cancelled',
    });
    taroFake.businessViewStatus = 'fail';
    await expect(platform.openOrderConfirm({ transactionId: '4200' })).resolves.toMatchObject({
      kind: 'failed',
    });
  });
});
