import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { profileFixture, rejected, signIn, signOut } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import ProfilePage from './index';

function typeNickname(value: string) {
  fireEvent.change(screen.getByLabelText('昵称'), { target: { value } });
}

describe('个人资料', () => {
  it('saves a new nickname', async () => {
    signIn();
    const seen = serveApi({
      'GET /api/v1/profile': () => ({ body: profileFixture }),
      'PUT /api/v1/profile': (body) => ({ body: { ...profileFixture, ...(body as object) } }),
    });
    await renderPage(<ProfilePage />);
    await screen.findByDisplayValue('小明');

    typeNickname('  小红 ');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(seen.find((r) => r.key === 'PUT /api/v1/profile')?.body).toEqual({
        nickname: '小红',
      }),
    );
  });

  it('shows a nickname the content check refused on the field (C09)', async () => {
    signIn();
    serveApi({
      'GET /api/v1/profile': () => ({ body: profileFixture }),
      'PUT /api/v1/profile': () =>
        rejected('USER_NICKNAME_REJECTED', '昵称包含不适宜的内容，请修改'),
    });
    await renderPage(<ProfilePage />);
    await screen.findByDisplayValue('小明');

    typeNickname('违规测试');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('昵称包含不适宜的内容，请修改')).toBeTruthy();
    typeNickname('小红');
    expect(screen.queryByText('昵称包含不适宜的内容，请修改')).toBeNull();
  });

  it('asks a signed-out shopper to sign in, without calling the profile', async () => {
    signOut();
    const seen = serveApi({});
    await renderPage(<ProfilePage />);
    expect(screen.getByText('还没有登录')).toBeTruthy();
    expect(seen).toHaveLength(0);
  });
});
