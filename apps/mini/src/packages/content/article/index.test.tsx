import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { platform } from '@/platform';
import { articleFixture } from '@/test/article-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import ArticlePage from './index';

describe('资讯详情', () => {
  beforeEach(() => {
    taroFake.routerParams = { id: '61' };
    serveApi({ 'GET /api/v1/articles/61': () => ({ body: articleFixture }) });
  });

  it('shows the article, its product, and shares its own title', async () => {
    await renderPage(<ArticlePage />);
    expect(await screen.findByText('第一步，温水清洗。')).toBeTruthy();
    expect(screen.getByText('护理知识 · 小编 · 2026.09.20 · 120 阅读')).toBeTruthy();

    expect(taroFake.shareHandlers.timeline?.()).toMatchObject({
      title: '日常清洁小贴士',
      query: 'id=61',
    });

    fireEvent.click(screen.getByRole('link', { name: '纯棉毛巾' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/pages/product/index?id=11' },
      }),
    );
  });

  it('says nothing of 0 阅读, and strikes no 划线价 at the price', async () => {
    serveApi({
      'GET /api/v1/articles/61': () => ({
        body: {
          ...articleFixture,
          views: 0,
          product: { ...articleFixture.product!, originalPrice: '19.90' },
        },
      }),
    });
    await renderPage(<ArticlePage />);
    expect(await screen.findByText('护理知识 · 小编 · 2026.09.20')).toBeTruthy();
    expect(screen.queryByRole('text', { name: /原价/ })).toBeNull();
  });

  it('loads a picture the editor stored site-relative from the shop, and drops blank ends', async () => {
    serveApi({
      'GET /api/v1/articles/61': () => ({
        body: {
          ...articleFixture,
          contentHtml: '<p><br></p><p>正文</p><p><img src="/uploads/a/1.jpg"></p><p></p>',
        },
      }),
    });
    // Tests run against an empty origin; give pictures one to be put against.
    const api = platform.api as { baseUrl: string };
    const origin = api.baseUrl;
    api.baseUrl = 'https://shop.example';
    try {
      const { container } = await renderPage(<ArticlePage />);
      await screen.findByText('正文');
      expect(container.querySelector('.article img')?.getAttribute('src')).toBe(
        'https://shop.example/uploads/a/1.jpg',
      );
      // The fake `<rich-text>` draws each paragraph as a span.
      const paragraphs = Array.from(container.querySelectorAll('[data-rich-text] > span'));
      expect(paragraphs.map((p) => p.textContent)).toEqual(['正文', '']);
    } finally {
      api.baseUrl = origin;
    }
  });

  it('opens 阅读原文 in the web-view and copies a link WeChat would refuse', async () => {
    await renderPage(<ArticlePage />);
    fireEvent.click(await screen.findByRole('link', { name: '阅读原文' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: {
          url: `/packages/content/webview/index?url=${encodeURIComponent('https://mp.weixin.qq.com/s/abc')}`,
        },
      }),
    );

    fireEvent.click(screen.getByRole('link', { name: '打开链接：使用指南' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'setClipboardData',
        args: { data: 'https://other.example.com/guide' },
      }),
    );
  });
});
