import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogAdminProductList } from '@shop/contracts/catalog/catalog.product.admin.contract';
import {
  cmsArticleDetail,
  cmsArticleList,
  cmsArticleSetStatus,
  cmsArticleUpdate,
  cmsCategoryList,
} from '@shop/contracts/cms/cms.admin.contract';
import type {
  AdminArticleDetail,
  AdminArticleListItem,
  ArticleCategory,
} from '@shop/contracts/cms/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { withStubAssets } from '@/test/asset-source';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { ArticlesPage } from './articles';

/**
 * 文章管理 as a component test.
 *
 * The wiring worth asserting: the table asks the contract route, the category
 * filter is fed by the category route rather than a second query of its own,
 * 发布/隐藏 goes through the status sub-resource (not a column written straight
 * from the list), and 删除 sits on its own atom.
 */

const row: AdminArticleListItem = {
  id: '101',
  categoryId: '3',
  categoryTitle: '新闻资讯',
  title: '双十一活动说明',
  slug: 'double-eleven-2026',
  author: '运营部',
  coverImageUrl: null,
  summary: null,
  sourceUrl: null,
  isHot: true,
  isBanner: false,
  views: 120,
  sortOrder: 50,
  publishedAt: '2026-06-01T10:00:00+08:00',
  status: 'published',
  productId: null,
  shareTitle: null,
  shareSummary: null,
  createdAt: '2026-06-01T09:00:00+08:00',
  updatedAt: '2026-06-01T09:00:00+08:00',
};

const category: ArticleCategory = {
  id: '3',
  parentId: null,
  title: '新闻资讯',
  intro: null,
  imageUrl: null,
  status: 'visible',
  sortOrder: 10,
  depth: 0,
  articleCount: 12,
  createdAt: '2026-01-01T09:00:00+08:00',
};

function stubApi(): StubCall[] {
  // Every single-article route answers with the detail, body and product included.
  const detail: AdminArticleDetail = { ...row, contentHtml: '<p>活动说明</p>', product: null };
  return stubRoutes([
    on(cmsCategoryList, { items: [category] }),
    on(catalogAdminProductList, { items: [], total: 0, page: 1, pageSize: 20 }),
    on(cmsArticleList, { items: [row], total: 1, page: 1, pageSize: 20 }),
    on(cmsArticleDetail, detail),
    on(cmsArticleUpdate, detail),
    on(cmsArticleSetStatus, { ...detail, status: 'hidden' }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const writer = {
  ...testIdentity,
  permissions: ['cms:article:read', 'cms:article:write'],
};

describe('文章管理', () => {
  it('lists articles from the contract route and names their category', async () => {
    const calls = stubApi();
    renderAdmin(<ArticlesPage />, { identity: writer });

    expect(await screen.findByText('双十一活动说明')).toBeInTheDocument();
    expect(screen.getByText('已发布')).toBeInTheDocument();
    // The row's 热门 tag; the 热门 filter is folded away behind 展开.
    expect(screen.getByText('热门')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/admin-api/cms/articles?page=1'))).toBe(true);
    // The 分类 filter is fed by the category route, not a second article query.
    expect(calls.some((call) => call.url.includes('/admin-api/cms/article-categories'))).toBe(true);
  });

  it('hides every write action from a read-only admin', async () => {
    stubApi();
    renderAdmin(<ArticlesPage />, {
      identity: { ...testIdentity, permissions: ['cms:article:read'] },
    });

    await screen.findByText('双十一活动说明');
    expect(screen.queryByRole('button', { name: /新建文章/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '隐藏' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  });

  it('takes a published article down through the status sub-resource', async () => {
    const calls = stubApi();
    renderAdmin(<ArticlesPage />, { identity: writer });
    await screen.findByText('双十一活动说明');

    await userEvent.click(screen.getByRole('button', { name: '隐藏' }));
    // Switching off is customer-visible, so it asks first.
    const popup = (await screen.findByText(/^隐藏文章「/)).closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: zhName('隐藏') }));

    await waitFor(() => {
      const flip = calls.find((call) => call.method === 'POST');
      expect(flip?.url).toContain('/admin-api/cms/articles/101/status');
      expect(flip?.body).toEqual({ status: 'hidden' });
    });
  });

  it('opens 编辑 on the loaded article, not an empty form', async () => {
    stubApi();
    renderAdmin(withStubAssets(<ArticlesPage />), { identity: writer });
    await screen.findByText('双十一活动说明');

    await userEvent.click(screen.getByRole('button', { name: '编辑' }));

    // The detail answers after the drawer opens; a form seeded at mount would
    // stay empty and a save would blank the article.
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByDisplayValue('双十一活动说明')).toBeInTheDocument();
    expect(within(drawer).getByDisplayValue('运营部')).toBeInTheDocument();
  });

  it('keeps 删除 on its own atom, which write alone does not grant', async () => {
    stubApi();
    renderAdmin(<ArticlesPage />, { identity: writer });

    await screen.findByText('双十一活动说明');
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  });
});
