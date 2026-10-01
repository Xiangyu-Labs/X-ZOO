import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSession } from '@/session/session';
import { profileFixture, rejected, signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import PasswordPage from './index';

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const miniLogin = {
  status: 'signed-in',
  session: { token: 't2', expiresAt: '2026-10-23T00:00:00.000Z', user: profileFixture },
  registered: false,
  bindToken: null,
  bindTokenExpiresInSec: null,
};

describe('修改密码', () => {
  it('changes it with the old password, then signs in again (every session ended)', async () => {
    signIn();
    const seen = serveApi({
      'GET /api/v1/profile': () => ({ body: profileFixture }),
      'PUT /api/v1/auth/password': () => ({ body: { ok: true } }),
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ status: 201, body: miniLogin }),
    });
    await renderPage(<PasswordPage />);
    await screen.findByLabelText('原密码');

    type('原密码', 'old-pass');
    type('新密码', 'new-pass-1');
    type('确认密码', 'new-pass-1');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));

    await waitFor(() =>
      expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 't2' }),
    );
    expect(seen.find((r) => r.key === 'PUT /api/v1/auth/password')?.body).toEqual({
      oldPassword: 'old-pass',
      password: 'new-pass-1',
    });
  });

  it('without a bound phone, 忘记原密码 is a way back to the old password, not a dead end', async () => {
    signIn();
    serveApi({ 'GET /api/v1/profile': () => ({ body: { ...profileFixture, phone: null } }) });
    await renderPage(<PasswordPage />);
    await screen.findByLabelText('原密码');

    fireEvent.click(screen.getByRole('button', { name: '忘记原密码？用短信验证码' }));
    expect(await screen.findByText('用短信验证码修改需要先绑定手机号。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '用原密码修改' }));
    expect(await screen.findByLabelText('原密码')).toBeTruthy();
  });

  it('says a wrong old password on its field', async () => {
    signIn();
    serveApi({
      'GET /api/v1/profile': () => ({ body: profileFixture }),
      'PUT /api/v1/auth/password': () => rejected('AUTH_OLD_PASSWORD_INVALID', '原密码不正确', 400),
    });
    await renderPage(<PasswordPage />);
    await screen.findByLabelText('原密码');

    type('原密码', 'wrong');
    type('新密码', 'new-pass-1');
    type('确认密码', 'new-pass-1');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));

    expect(await screen.findByText('原密码不正确')).toBeTruthy();
  });

  it('sets a first password with an SMS code to the bound number', async () => {
    signIn();
    const seen = serveApi({
      'GET /api/v1/profile': () => ({ body: { ...profileFixture, hasPassword: false } }),
      'POST /api/v1/auth/sms-codes': () => ({
        status: 202,
        body: { expiresInSec: 300, resendAfterSec: 60 },
      }),
    });
    await renderPage(<PasswordPage />);

    fireEvent.click(await screen.findByRole('button', { name: '获取验证码' }));

    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/auth/sms-codes')?.body).toEqual({
        phone: '13800138000',
        scene: 'reset-password',
      }),
    );
    expect(screen.getByRole('button', { name: '设置密码' })).toBeTruthy();
    expect(screen.queryByLabelText('原密码')).toBeNull();
  });
});
