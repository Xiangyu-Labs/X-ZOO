import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import AgreementPage from './index';

describe('协议', () => {
  it('shows the agreement the key names, with its date', async () => {
    taroFake.routerParams = { key: 'privacy' };
    const seen = serveApi({
      'GET /api/v1/agreements/privacy': () => ({
        body: {
          key: 'privacy',
          title: '隐私政策',
          content: '<p>我们只收集下单必需的信息。</p>',
          updatedAt: '2026-09-20T18:30:00+08:00',
        },
      }),
    });
    await renderPage(<AgreementPage />);
    expect(await screen.findByText('更新于 2026.09.20')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看《小程序隐私保护指引》' })).toBeTruthy();
    expect(seen.map((r) => r.key)).toEqual(['GET /api/v1/agreements/privacy']);
  });

  it('falls back to 用户协议 for an unknown key, and says when there is no text yet', async () => {
    taroFake.routerParams = { key: 'nope' };
    serveApi({
      'GET /api/v1/agreements/user': () => ({
        body: { key: 'user', title: '', content: '', updatedAt: null },
      }),
    });
    await renderPage(<AgreementPage />);
    expect(await screen.findByText('内容整理中')).toBeTruthy();
    expect(screen.getByText('用户协议')).toBeTruthy();
  });
});
