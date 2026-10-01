import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setWebviewDomains } from '@/platform';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import WebviewPage from './index';

describe('网页 (C12)', () => {
  afterEach(() => setWebviewDomains([]));

  it('opens an official-account article and a 业务域名 in the web-view', async () => {
    setWebviewDomains(['h5.example.com']);
    for (const url of ['https://mp.weixin.qq.com/s/abc', 'https://h5.example.com/a?b=1']) {
      taroFake.routerParams = { url: encodeURIComponent(url) };
      const { unmount } = await renderPage(<WebviewPage />);
      expect(screen.getByTestId('web-view').getAttribute('data-src')).toBe(url);
      unmount();
    }
  });

  it('offers to copy any other link instead', async () => {
    taroFake.routerParams = { url: 'http://h5.example.com/a' };
    await renderPage(<WebviewPage />);
    expect(screen.queryByTestId('web-view')).toBeNull();
    expect(screen.getByRole('dialog', { name: '该链接需在浏览器中打开' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制链接' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'setClipboardData',
        args: { data: 'http://h5.example.com/a' },
      }),
    );
  });
});
