import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import { LoginCard } from './login-card';
import { useSession } from './session';

describe('LoginCard · 手机号快速登录', () => {
  it('says what a refused privacy sheet means, in Chinese, and stays parked', async () => {
    useSession.setState({ session: { status: 'phone-required', bindToken: 'bind-1' } });
    taroFake.phoneNumberDetail = {
      errMsg: 'getPhoneNumber:fail privacy permission is not authorized',
    };
    const seen = serveApi({});
    await renderPage(<LoginCard reason="登录后即可购买">{null}</LoginCard>);

    fireEvent.click(await screen.findByRole('button', { name: '手机号快速登录' }));

    expect(taroFake.calls).toContainEqual({
      api: 'showToast',
      args: expect.objectContaining({ title: '未同意隐私保护指引，可改用短信验证码登录' }),
    });
    expect(
      taroFake.calls.some(
        (call) => call.api === 'showToast' && /privacy/i.test(JSON.stringify(call.args)),
      ),
    ).toBe(false);
    expect(seen).toHaveLength(0);
    expect(useSession.getState().session).toEqual({
      status: 'phone-required',
      bindToken: 'bind-1',
    });
  });
});

describe('LoginCard · 其他方式登录', () => {
  it('links the login page after 微信登录 fails, so 密码登录 stays reachable', async () => {
    useSession.setState({ session: { status: 'failed', message: '微信登录暂未开放' } });
    await renderPage(
      <LoginCard reason="登录后即可购买" redirect={{ route: 'cart', params: {} }}>
        {null}
      </LoginCard>,
    );

    expect(await screen.findByText('微信登录暂未开放')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '其他方式登录' }));

    await vi.waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: expect.stringMatching(/^\/pages\/login\/index\?redirect=/) },
      }),
    );
  });

  it('links it after a sign-out too', async () => {
    useSession.setState({ session: { status: 'signed-out' } });
    await renderPage(<LoginCard reason="登录后即可购买">{null}</LoginCard>);
    expect(await screen.findByRole('button', { name: '其他方式登录' })).toBeTruthy();
  });
});
