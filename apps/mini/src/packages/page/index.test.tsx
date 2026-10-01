import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppConfigStore } from '@/app-config';
import { useSession } from '@/session/session';
import { appConfigFixture } from '@/test/app-config-fixture';
import { resolvedPageFixture } from '@/test/decor-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import MicroPage from './index';

const TOKEN = 'preview_token_0123456789';
const microPage = (preview = false) =>
  resolvedPageFixture({
    id: '9',
    kind: 'custom',
    preview,
    root: {
      props: {
        title: '秋季专题',
        background: '#f5f5f5',
        shareEnabled: true,
        shareTitle: '秋季好物',
      },
    },
  });

describe('微页面', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'idle' } });
    useAppConfigStore.setState({ config: appConfigFixture, source: 'network' });
  });

  it('shows a published page with its own title and share card', async () => {
    taroFake.routerParams = { id: '9' };
    const seen = serveApi({ 'GET /api/v1/pages/9': () => ({ body: microPage() }) });
    await renderPage(<MicroPage />);

    await waitFor(() =>
      expect(screen.getByTestId('navigation-bar').getAttribute('data-title')).toBe('秋季专题'),
    );
    expect(seen.find((r) => r.key === 'GET /api/v1/pages/9')?.query).toEqual({});
    expect(document.getElementById('decor-preview-banner')).toBeNull();
    expect(taroFake.shareHandlers.message?.()).toMatchObject({
      title: '秋季好物',
      path: '/packages/page/index?id=9',
    });
  });

  it('previews a draft: sends the token, shows the banner, never shares the draft', async () => {
    taroFake.routerParams = { id: '9', previewToken: TOKEN };
    const seen = serveApi({ 'GET /api/v1/pages/9': () => ({ body: microPage(true) }) });
    await renderPage(<MicroPage />);

    expect(await screen.findByText(/草稿预览/)).toBeTruthy();
    expect(seen.find((r) => r.key === 'GET /api/v1/pages/9')?.query).toEqual({
      previewToken: TOKEN,
    });
    const share = taroFake.shareHandlers.message?.() as { path?: string; title?: string };
    expect(share.path).toBe('/pages/index/index');
    expect(share.title).not.toBe('秋季好物');
  });

  it('ignores a malformed preview token', async () => {
    taroFake.routerParams = { id: '9', previewToken: 'x<y' };
    const seen = serveApi({ 'GET /api/v1/pages/9': () => ({ body: microPage() }) });
    await renderPage(<MicroPage />);

    await waitFor(() => expect(seen.some((r) => r.key === 'GET /api/v1/pages/9')).toBe(true));
    expect(seen.find((r) => r.key === 'GET /api/v1/pages/9')?.query).toEqual({});
    expect(document.getElementById('decor-preview-banner')).toBeNull();
  });

  it('says an expired preview has expired, and a missing page is gone', async () => {
    taroFake.routerParams = { id: '9', previewToken: TOKEN };
    serveApi({
      'GET /api/v1/pages/9': () => ({
        status: 403,
        body: { code: 'DECOR_PREVIEW_TOKEN_INVALID', message: 'invalid' },
      }),
    });
    const { unmount } = await renderPage(<MicroPage />);
    expect(await screen.findByText('预览已过期')).toBeTruthy();
    unmount();

    taroFake.routerParams = { id: '404' };
    serveApi({
      'GET /api/v1/pages/404': () => ({
        status: 404,
        body: { code: 'DECOR_DOCUMENT_NOT_FOUND', message: 'not found' },
      }),
    });
    await renderPage(<MicroPage />);
    expect(await screen.findByText('页面不存在')).toBeTruthy();
  });
});
