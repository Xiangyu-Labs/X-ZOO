import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { page } from '@/test/account-fixture';
import { articleFixture } from '@/test/article-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import ArticlesPage, { categoryFilter } from './index';

const categories = [
  {
    id: '5',
    title: '护理知识',
    imageUrl: null,
    children: [{ id: '6', title: '清洁', imageUrl: null }],
  },
  { id: '7', title: '店铺公告', imageUrl: null, children: [] },
];

describe('资讯', () => {
  it('lists articles, filters by a category and its children, and opens one', async () => {
    const seen = serveApi({
      'GET /api/v1/article-categories': () => ({ body: { items: categories } }),
      'GET /api/v1/articles': () => ({ body: page([articleFixture]) }),
    });
    await renderPage(<ArticlesPage />);

    fireEvent.click(await screen.findByRole('tab', { name: '护理知识' }));
    await waitFor(() =>
      expect(seen.filter((r) => r.key === 'GET /api/v1/articles')).toHaveLength(2),
    );
    const last = taroFake.calls.filter((c) => c.api === 'request').at(-1);
    expect(JSON.stringify(last?.args)).toContain('categoryIds=5%2C6');

    fireEvent.click((await screen.findAllByRole('link', { name: '日常清洁小贴士' }))[0]!);
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/content/article/index?id=61' },
      }),
    );
    expect(taroFake.shareHandlers.message?.()).toMatchObject({
      title: '护理知识',
      path: '/packages/content/articles/index?categoryId=5',
    });
  });

  it('builds the category filter', () => {
    expect(categoryFilter(categories, 'all')).toEqual({});
    expect(categoryFilter(categories, '5')).toEqual({ categoryIds: '5,6' });
    expect(categoryFilter(categories, '6')).toEqual({ categoryIds: '6' });
  });
});
