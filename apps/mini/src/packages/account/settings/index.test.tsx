import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSession } from '@/session/session';
import { signIn, signOut } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import SettingsPage from './index';

describe('设置', () => {
  it('lists the agreements and 注销账号 (C18)', async () => {
    signOut();
    serveApi({});
    await renderPage(<SettingsPage />);

    fireEvent.click(screen.getByRole('link', { name: '隐私政策' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/pages/agreement/index?key=privacy' },
      }),
    );
    expect(screen.getByRole('link', { name: '注销账号' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull();
  });

  it('signs out after a confirmation, revoking the session on the server', async () => {
    signIn();
    const seen = serveApi({
      'DELETE /api/v1/auth/sessions/current': () => ({ body: { ok: true } }),
    });
    await renderPage(<SettingsPage />);

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(useSession.getState().session.status).toBe('signed-out'));
    expect(seen.map((r) => r.key)).toEqual(['DELETE /api/v1/auth/sessions/current']);
    expect(taroFake.calls.some((call) => call.api === 'showModal')).toBe(true);
  });

  it('keeps the session when the confirmation is cancelled', async () => {
    signIn();
    taroFake.modalConfirm = false;
    const seen = serveApi({});
    await renderPage(<SettingsPage />);

    fireEvent.click(screen.getByRole('button', { name: '退出全部设备' }));

    await waitFor(() => expect(taroFake.calls.some((c) => c.api === 'showModal')).toBe(true));
    expect(useSession.getState().session.status).toBe('signed-in');
    expect(seen).toHaveLength(0);
  });
});
