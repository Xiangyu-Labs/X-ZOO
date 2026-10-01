import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  articleDetail,
  articleDetailExample,
  articleListItemExample,
  articleListQuery,
  pagedArticles,
  publicArticleCategoryList,
} from './schemas';

/**
 * The storefront's reading surface, `/api/v1/articles` and
 * `/api/v1/article-categories`.
 *
 * Two lists and a detail. By category, 热门, banner and a DIY component's
 * picked articles are the same query with one `where` swapped, so they are one
 * `GET /api/v1/articles` with `categoryId`, `feature` and `ids`.
 *
 * Everything here is `public`: an article is marketing copy, and requiring a
 * session to read one would break the share links the whole feature exists for.
 */

export const articleCategoriesPublic = defineRoute({
  id: 'cms.categoryList',
  method: 'GET',
  path: '/api/v1/article-categories',
  auth: 'public',
  summary: '文章分类',
  tags: ['cms'],
  response: publicArticleCategoryList,
  examples: [
    {
      name: 'ok',
      response: {
        items: [
          {
            id: '3',
            title: '新闻资讯',
            imageUrl: '/uploads/2026/01/news.png',
            children: [{ id: '4', title: '商城公告', imageUrl: null }],
          },
        ],
      },
    },
  ],
});

export const articleListPublic = defineRoute({
  id: 'cms.articleList',
  method: 'GET',
  path: '/api/v1/articles',
  auth: 'public',
  summary: '文章列表',
  tags: ['cms'],
  query: articleListQuery,
  response: pagedArticles,
  examples: [
    {
      name: 'by-category',
      query: { page: 1, pageSize: 10, categoryId: '3' },
      response: { items: [articleListItemExample], total: 1, page: 1, pageSize: 10 },
    },
    {
      name: 'hot',
      query: { page: 1, pageSize: 10, feature: 'hot' },
      response: { items: [articleListItemExample], total: 1, page: 1, pageSize: 10 },
    },
    {
      name: 'banner',
      query: { page: 1, pageSize: 5, feature: 'banner' },
      response: { items: [], total: 0, page: 1, pageSize: 5 },
    },
    {
      // A DIY component's 指定数据: 104 is a draft now, so it is skipped; the
      // rest come back in the order asked for.
      name: 'picked',
      query: { page: 1, pageSize: 3, ids: '102,104,101' },
      response: {
        items: [{ ...articleListItemExample, id: '102' }, articleListItemExample],
        total: 2,
        page: 1,
        pageSize: 3,
      },
    },
  ],
});

/**
 * Reading an article increments its view counter — one atomic
 * `UPDATE … SET views = views + 1 RETURNING views`, so the number in the
 * response is the one this read produced. Reading the counter, adding one and
 * writing it back would lose increments under any concurrency at all.
 */
export const articleDetailPublic = defineRoute({
  id: 'cms.articleDetail',
  method: 'GET',
  path: '/api/v1/articles/:id',
  auth: 'public',
  summary: '文章详情',
  tags: ['cms'],
  params: z.object({ id }),
  response: articleDetail,
  errors: ['CMS_ARTICLE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '101' }, response: articleDetailExample }],
});
