import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppConfigStore } from '@/app-config/app-config';
import { useSession } from '@/session/session';
import { appConfigFixture } from '@/test/app-config-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import { PosterSheet, type PosterSubject } from './poster-sheet';

const subject: PosterSubject = {
  route: 'groupbuyTeam',
  id: '501',
  title: '双人团 · 护理套装',
  price: '68.00',
  originalPrice: '98.00',
  imageUrl: '/uploads/p/1.jpg',
  badge: '2 人团 · 还差 1 人成团',
};

function open(codeStatus = 200) {
  const seen = serveApi({
    'GET /api/v1/share/mini-codes': () =>
      codeStatus === 200
        ? { body: { url: '/uploads/wechat-mini-code/2026/09/a.png' } }
        : {
            status: codeStatus,
            body: { code: 'WECHAT_MINI_CODE_FAILED', message: '小程序码生成失败' },
          },
  });
  void renderPage(<PosterSheet visible onClose={() => undefined} subject={subject} />);
  return seen;
}

const called = (api: string) => taroFake.calls.filter((call) => call.api === api);

describe('PosterSheet', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
    useAppConfigStore.setState({ config: appConfigFixture, source: 'network' });
  });

  it('asks for the route’s 小程序码, draws the poster and shows it', async () => {
    const seen = open();
    expect((await screen.findByAltText('分享海报')).getAttribute('src')).toBe(
      'wxfile://tmp/poster.jpg',
    );
    expect(seen.find((r) => r.key === 'GET /api/v1/share/mini-codes')?.query).toEqual({
      route: 'groupbuyTeam',
      id: '501',
    });
    // Both pictures come through downloadFile (the downloadFile domain), then the canvas.
    expect(called('downloadFile').map((call) => (call.args as { url: string }).url)).toEqual([
      expect.stringContaining('/uploads/p/1.jpg'),
      expect.stringContaining('/uploads/wechat-mini-code/2026/09/a.png'),
    ]);
    expect(called('canvasToTempFilePath')).toHaveLength(1);
  });

  it('redraws without the product picture on request', async () => {
    open();
    await screen.findByAltText('分享海报');
    fireEvent.click(screen.getByRole('switch', { name: '不显示商品图片' }));
    await waitFor(() => expect(called('canvasToTempFilePath')).toHaveLength(2));
    const downloads = called('downloadFile').map((call) => (call.args as { url: string }).url);
    expect(downloads.filter((url) => url.includes('/uploads/p/1.jpg'))).toHaveLength(1);
  });

  it('saves to the album', async () => {
    open();
    await screen.findByAltText('分享海报');
    fireEvent.click(screen.getByRole('button', { name: '保存到相册' }));
    await screen.findByRole('button', { name: '已保存，可再次保存' });
    expect(called('saveImageToPhotosAlbum')[0]?.args).toEqual({
      filePath: 'wxfile://tmp/poster.jpg',
    });
  });

  it('offers 去设置 after a refused 相册 permission, and saves once it is granted', async () => {
    taroFake.album = 'deny';
    open();
    await screen.findByAltText('分享海报');
    fireEvent.click(screen.getByRole('button', { name: '保存到相册' }));
    await screen.findByText(/需要「添加到相册」权限/);

    taroFake.album = 'ok';
    fireEvent.click(screen.getByRole('button', { name: '去设置' }));
    await screen.findByRole('button', { name: '已保存，可再次保存' });
    expect(called('openSetting')).toHaveLength(1);
    expect(called('saveImageToPhotosAlbum')).toHaveLength(2);
  });

  it('stays on the poster when the privacy guide is declined', async () => {
    taroFake.album = 'privacy';
    open();
    await screen.findByAltText('分享海报');
    fireEvent.click(screen.getByRole('button', { name: '保存到相册' }));
    await waitFor(() => expect(called('showToast')).toHaveLength(1));
    expect(screen.getAllByRole('button', { name: '保存到相册' })).toHaveLength(1);
  });

  it('says why when the code cannot be made, and retries', async () => {
    const seen = open(502);
    await screen.findByText('小程序码生成失败');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() =>
      expect(seen.filter((r) => r.key === 'GET /api/v1/share/mini-codes')).toHaveLength(2),
    );
  });
});
