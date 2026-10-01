import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_KEY, useSession, useSessionNotice } from '@/session/session';
import { profileFixture, rejected } from '@/test/account-fixture';
import { holdRequests, serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import LoginPage from './index';

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const session = {
  token: 'pw-token',
  expiresAt: '2026-10-23T00:00:00.000Z',
  user: profileFixture,
};

async function openPasswordForm() {
  await renderPage(<LoginPage />);
  fireEvent.click(await screen.findByRole('button', { name: '密码登录' }));
  await screen.findByLabelText('账号');
}

describe('登录 · 其他方式 · 密码登录', () => {
  beforeEach(() => {
    // The silent sign-in wanted a phone number: 其他方式 is offered there too.
    useSession.setState({ session: { status: 'phone-required', bindToken: 'bind-1' } });
  });

  it('asks for the terms first, then signs in with the account and password', async () => {
    const seen = serveApi({
      'POST /api/v1/auth/sessions/password': () => ({ status: 201, body: session }),
    });
    await openPasswordForm();

    type('账号', ' 13800138000 ');
    type('密码', 'secret-1');
    const login = screen.getByRole('button', { name: '登录' });
    fireEvent.click(login);
    expect(taroFake.calls).toContainEqual({
      api: 'showToast',
      args: expect.objectContaining({ title: '请先阅读并同意用户协议和隐私政策' }),
    });
    expect(seen).toHaveLength(0);
    // The refused tap's handler settles before the button takes another.
    await waitFor(() => expect(login.className).not.toContain('shop-btn--loading'));

    fireEvent.click(screen.getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }));
    fireEvent.click(login);

    await waitFor(() =>
      expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 'pw-token' }),
    );
    // From the parked sign-in, the bindToken goes along and the server links the openid (AUTH-009).
    expect(seen[0]?.body).toEqual({
      account: '13800138000',
      password: 'secret-1',
      bindToken: 'bind-1',
    });
    expect(taroFake.storage.get(TOKEN_KEY)).toBe('pw-token');
    // Signed in, the page goes home (no redirect).
    await waitFor(() =>
      expect(
        taroFake.calls.some((call) => call.api === 'switchTab' || call.api === 'reLaunch'),
      ).toBe(true),
    );

    // It leaves once: a later renewal, with this page still mounted under the tab it went to,
    // does not send the shopper home again (SMOKE-004's renewal step).
    const leaves = () =>
      taroFake.calls.filter((call) => call.api === 'switchTab' || call.api === 'reLaunch').length;
    const before = leaves();
    act(() => useSession.setState({ session: { status: 'signing-in' } }));
    act(() => useSession.setState({ session: { status: 'signed-in', token: 'renewed' } }));
    expect(leaves()).toBe(before);
  });

  it('tells the shopper, once on the page they were going to, when this WeChat belongs to another account', async () => {
    const seen = serveApi({
      'POST /api/v1/auth/sessions/password': (body) =>
        (body as { bindToken?: string }).bindToken
          ? rejected('AUTH_WECHAT_ALREADY_BOUND', '该微信已绑定其他账号', 409)
          : { status: 201, body: session },
    });
    await openPasswordForm();
    fireEvent.click(screen.getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }));
    type('账号', '13800138000');
    type('密码', 'secret-1');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    const hint = '此微信已关联其他账号，本账号需用密码登录';
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'showToast',
        args: expect.objectContaining({ title: hint, duration: 3000 }),
      }),
    );
    // Signed in without the link (H6), and the hint comes after leaving, not on this page.
    expect(seen).toHaveLength(2);
    const apis = taroFake.calls.map((call) => call.api);
    const left = apis.findIndex((api) => api === 'switchTab' || api === 'reLaunch');
    const shown = taroFake.calls.findIndex(
      (call) => call.api === 'showToast' && (call.args as { title?: string }).title === hint,
    );
    expect(left).toBeGreaterThanOrEqual(0);
    expect(shown).toBeGreaterThan(left);
  });

  it('says a wrong password on the password field, and stays parked for WeChat', async () => {
    serveApi({
      'POST /api/v1/auth/sessions/password': () =>
        rejected('AUTH_INVALID_CREDENTIALS', '账号或密码不正确', 401),
    });
    await openPasswordForm();
    fireEvent.click(screen.getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }));

    type('账号', 'u7');
    type('密码', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('账号或密码不正确')).toBeTruthy();
    expect(useSession.getState().session).toEqual({
      status: 'phone-required',
      bindToken: 'bind-1',
    });
  });

  it('checks both fields before asking the server', async () => {
    const seen = serveApi({});
    await openPasswordForm();
    fireEvent.click(screen.getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }));

    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('请输入手机号或账号')).toBeTruthy();
    expect(screen.getByText('请输入密码')).toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it('opens 找回密码 from 忘记密码, and goes back to the WeChat ways', async () => {
    serveApi({});
    await openPasswordForm();

    fireEvent.click(screen.getByRole('button', { name: '忘记密码' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/account/password-reset/index' },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '使用微信登录' }));
    expect(await screen.findByRole('button', { name: '手机号快速登录' })).toBeTruthy();
    expect(screen.queryByLabelText('账号')).toBeNull();
  });
});

describe('登录 · 手机号快速登录', () => {
  it('says what a refused privacy sheet means, in Chinese, and stays parked', async () => {
    useSession.setState({ session: { status: 'phone-required', bindToken: 'bind-1' } });
    taroFake.phoneNumberDetail = {
      errMsg: 'getPhoneNumber:fail privacy permission is not authorized',
    };
    const seen = serveApi({});
    await renderPage(<LoginPage />);
    fireEvent.click(screen.getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }));

    fireEvent.click(await screen.findByRole('button', { name: '手机号快速登录' }));

    expect(taroFake.calls).toContainEqual({
      api: 'showToast',
      args: expect.objectContaining({ title: '未同意隐私保护指引，可改用短信验证码登录' }),
    });
    expect(seen).toHaveLength(0);
    expect(useSession.getState().session).toEqual({
      status: 'phone-required',
      bindToken: 'bind-1',
    });
  });
});

describe('登录 · 短信验证码', () => {
  it('opens on the SMS form from a 「短信验证码登录」 link, and keeps it while the code is checked', async () => {
    useSession.setState({ session: { status: 'phone-required', bindToken: 'bind-1' } });
    taroFake.routerParams = { mode: 'sms' };
    const seen = serveApi({
      'POST /api/v1/auth/sessions/wechat-oa/phone': () => ({
        status: 201,
        body: {
          status: 'signed-in',
          session,
          registered: false,
          bindToken: null,
          bindTokenExpiresInSec: null,
        },
      }),
    });
    const held = holdRequests('/wechat-oa/phone');
    await renderPage(<LoginPage />);

    // No second tap on 短信验证码登录: the form is there.
    fireEvent.click(screen.getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }));
    type('手机号', '13800138000');
    type('验证码', '123456');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(useSession.getState().session.status).toBe('signing-in'));
    // The page does not swap to the WeChat buttons meanwhile.
    expect(screen.getByLabelText('验证码')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '登录中…' })).toBeNull();

    held.release();
    await waitFor(() =>
      expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 'pw-token' }),
    );
    expect(seen[0]?.body).toEqual({ bindToken: 'bind-1', phone: '13800138000', code: '123456' });
  });
});

describe('AUTH-010 — the notice of a renewal that reached another account', () => {
  it('says why the shopper is here in place of the hint, and drops it on leaving', async () => {
    useSession.setState({ session: { status: 'signed-out' } });
    useSessionNotice.setState({ notice: '登录已过期，请重新登录' });

    const { unmount } = await renderPage(<LoginPage />);

    expect(screen.getByText('登录已过期，请重新登录')).toBeTruthy();
    expect(screen.queryByText('登录后可以下单、查看订单和领取优惠券')).toBeNull();
    unmount();
    expect(useSessionNotice.getState().notice).toBeNull();
  });

  it('shows the usual hint when the session did not send the shopper here', async () => {
    useSession.setState({ session: { status: 'signed-out' } });
    useSessionNotice.setState({ notice: null });

    await renderPage(<LoginPage />);

    expect(screen.getByText('登录后可以下单、查看订单和领取优惠券')).toBeTruthy();
    expect(screen.queryByText('登录已过期，请重新登录')).toBeNull();
  });
});
