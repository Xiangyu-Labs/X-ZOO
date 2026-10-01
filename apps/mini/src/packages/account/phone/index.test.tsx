import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { profileFixture, signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import PhonePage from './index';

describe('手机号', () => {
  it('binds WeChat’s own number when there is none', async () => {
    signIn();
    taroFake.pageStackDepth = 2;
    const seen = serveApi({
      'GET /api/v1/profile': () => ({ body: { ...profileFixture, phone: null } }),
      'POST /api/v1/auth/phone/wechat-mini': () => ({ body: { ok: true } }),
    });
    await renderPage(<PhonePage />);

    fireEvent.click(await screen.findByText('使用微信手机号'));

    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/auth/phone/wechat-mini')?.body).toEqual({
        phoneCode: 'fake-phone-code',
      }),
    );
    await waitFor(() => expect(taroFake.calls.some((c) => c.api === 'navigateBack')).toBe(true));
  });

  it('says what a refused privacy sheet means, in Chinese, and binds nothing', async () => {
    signIn();
    taroFake.phoneNumberDetail = {
      errMsg: 'getPhoneNumber:fail privacy permission is not authorized',
    };
    const seen = serveApi({
      'GET /api/v1/profile': () => ({ body: { ...profileFixture, phone: null } }),
    });
    await renderPage(<PhonePage />);

    fireEvent.click(await screen.findByText('使用微信手机号'));

    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'showToast',
        args: expect.objectContaining({ title: '未同意隐私保护指引，可改用其他手机号绑定' }),
      }),
    );
    expect(seen.map((r) => r.key)).toEqual(['GET /api/v1/profile']);
  });

  it('changes a bound number with an SMS code to the new one', async () => {
    signIn();
    const seen = serveApi({
      'GET /api/v1/profile': () => ({ body: profileFixture }),
      'POST /api/v1/auth/sms-codes': () => ({
        status: 202,
        body: { expiresInSec: 300, resendAfterSec: 60 },
      }),
      'PUT /api/v1/auth/phone': () => ({ body: { ok: true } }),
    });
    await renderPage(<PhonePage />);
    expect(await screen.findByText('138****8000')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13900139000' } });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
    fireEvent.change(screen.getByLabelText('验证码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '确认更换' }));

    await waitFor(() =>
      expect(seen.find((r) => r.key === 'PUT /api/v1/auth/phone')?.body).toEqual({
        phone: '13900139000',
        code: '123456',
      }),
    );
    expect(seen.find((r) => r.key === 'POST /api/v1/auth/sms-codes')?.body).toEqual({
      phone: '13900139000',
      scene: 'change-phone',
    });
  });
});
