import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  adminArticleDetail,
  adminArticleDetailExample,
  adminArticleExample,
  adminArticleListQuery,
  articleCategoryChildExample,
  articleCategoryExample,
  articleCategoryForm,
  articleCategoryList,
  articleCategoryListQuery,
  articleCategoryStatusBody,
  articleCategory as articleCategorySchema,
  articleForm,
  articleStatusBody,
  pagedAdminArticles,
} from './schemas';

/**
 * 文章管理, `/admin-api/cms/*`.
 *
 * There is no separate route to link or unlink an article's product.
 * `productId` is a field of the article form like any other, so the relation is
 * edited where the rest of the article is, in one save, with one audit entry —
 * and there is no second write path that skips validation.
 */

const articleParams = z.object({ id });
const categoryParams = z.object({ id });

// ---------------------------------------------------------------------------
// articles
// ---------------------------------------------------------------------------

export const cmsArticleList = defineRoute({
  id: 'cms.adminArticleList',
  method: 'GET',
  path: '/admin-api/cms/articles',
  auth: 'admin',
  permission: 'cms:article:read',
  summary: '文章列表',
  tags: ['cms'],
  query: adminArticleListQuery,
  response: pagedAdminArticles,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [adminArticleExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'drafts',
      query: { page: 1, pageSize: 20, status: 'draft' },
      response: { items: [], total: 0, page: 1, pageSize: 20 },
    },
  ],
});

export const cmsArticleDetail = defineRoute({
  id: 'cms.adminArticleDetail',
  method: 'GET',
  path: '/admin-api/cms/articles/:id',
  auth: 'admin',
  permission: 'cms:article:read',
  summary: '文章详情',
  tags: ['cms'],
  params: articleParams,
  response: adminArticleDetail,
  errors: ['CMS_ARTICLE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '101' }, response: adminArticleDetailExample }],
});

export const cmsArticleCreate = defineRoute({
  id: 'cms.adminArticleCreate',
  method: 'POST',
  path: '/admin-api/cms/articles',
  auth: 'admin',
  permission: 'cms:article:write',
  summary: '新建文章',
  tags: ['cms'],
  body: articleForm,
  response: adminArticleDetail,
  status: 201,
  errors: ['CMS_CATEGORY_NOT_FOUND', 'CMS_ARTICLE_SLUG_TAKEN'],
  examples: [
    {
      name: 'published',
      body: {
        title: '双十一活动说明',
        categoryId: '3',
        slug: 'double-eleven-2026',
        author: '运营部',
        coverImageUrl: '/uploads/2026/10/cover.png',
        summary: '活动时间、优惠券发放与常见问题。',
        shareTitle: '双十一来了',
        shareSummary: '满 199 减 20',
        productId: '77',
        contentHtml: '<p>活动时间：11 月 1 日至 11 月 11 日。</p><p>全场满 199 减 20。</p>',
        status: 'published',
        isHot: true,
        sortOrder: 50,
      },
      response: adminArticleDetailExample,
    },
    {
      name: 'draft-minimal',
      body: { title: '草稿' },
      response: {
        ...adminArticleDetailExample,
        id: '102',
        title: '草稿',
        slug: null,
        author: null,
        coverImageUrl: null,
        summary: null,
        shareTitle: null,
        shareSummary: null,
        categoryId: null,
        categoryTitle: null,
        productId: null,
        product: null,
        contentHtml: '',
        status: 'draft',
        isHot: false,
        isBanner: false,
        views: 0,
        sortOrder: 0,
        publishedAt: null,
      },
    },
  ],
});

export const cmsArticleUpdate = defineRoute({
  id: 'cms.adminArticleUpdate',
  method: 'PUT',
  path: '/admin-api/cms/articles/:id',
  auth: 'admin',
  permission: 'cms:article:write',
  summary: '编辑文章',
  tags: ['cms'],
  params: articleParams,
  body: articleForm,
  response: adminArticleDetail,
  errors: ['CMS_ARTICLE_NOT_FOUND', 'CMS_CATEGORY_NOT_FOUND', 'CMS_ARTICLE_SLUG_TAKEN'],
  examples: [
    {
      name: 'retitle',
      params: { id: '101' },
      body: {
        title: '双十一活动说明',
        categoryId: '3',
        contentHtml: '<p>活动时间：11 月 1 日至 11 月 11 日。</p>',
        status: 'published',
      },
      response: adminArticleDetailExample,
    },
  ],
});

export const cmsArticleSetStatus = defineRoute({
  id: 'cms.adminArticleSetStatus',
  method: 'POST',
  path: '/admin-api/cms/articles/:id/status',
  auth: 'admin',
  permission: 'cms:article:write',
  summary: '发布/隐藏文章',
  tags: ['cms'],
  params: articleParams,
  body: articleStatusBody,
  response: adminArticleDetail,
  errors: ['CMS_ARTICLE_NOT_FOUND'],
  examples: [
    {
      name: 'hide',
      params: { id: '101' },
      body: { status: 'hidden' },
      response: { ...adminArticleDetailExample, status: 'hidden' },
    },
  ],
});

export const cmsArticleDelete = defineRoute({
  id: 'cms.adminArticleDelete',
  method: 'DELETE',
  path: '/admin-api/cms/articles/:id',
  auth: 'admin',
  permission: 'cms:article:delete',
  summary: '删除文章',
  tags: ['cms'],
  params: articleParams,
  response: z.object({ deleted: z.literal(true) }),
  errors: ['CMS_ARTICLE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '101' }, response: { deleted: true } }],
});

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

export const cmsCategoryList = defineRoute({
  id: 'cms.adminCategoryList',
  method: 'GET',
  path: '/admin-api/cms/article-categories',
  auth: 'admin',
  permission: 'cms:article:read',
  summary: '文章分类列表',
  tags: ['cms'],
  query: articleCategoryListQuery,
  response: articleCategoryList,
  examples: [
    {
      name: 'ok',
      query: {},
      response: { items: [articleCategoryExample, articleCategoryChildExample] },
    },
  ],
});

export const cmsCategoryCreate = defineRoute({
  id: 'cms.adminCategoryCreate',
  method: 'POST',
  path: '/admin-api/cms/article-categories',
  auth: 'admin',
  permission: 'cms:category:write',
  summary: '新建文章分类',
  tags: ['cms'],
  body: articleCategoryForm,
  response: articleCategorySchema,
  status: 201,
  errors: ['CMS_CATEGORY_NOT_FOUND', 'CMS_CATEGORY_TOO_DEEP'],
  examples: [
    {
      name: 'top-level',
      body: {
        title: '新闻资讯',
        intro: '商城公告与行业动态',
        imageUrl: '/uploads/2026/01/news.png',
        sortOrder: 10,
      },
      response: articleCategoryExample,
    },
    {
      name: 'child',
      body: { title: '商城公告', parentId: '3', sortOrder: 20 },
      response: articleCategoryChildExample,
    },
  ],
});

export const cmsCategoryUpdate = defineRoute({
  id: 'cms.adminCategoryUpdate',
  method: 'PUT',
  path: '/admin-api/cms/article-categories/:id',
  auth: 'admin',
  permission: 'cms:category:write',
  summary: '编辑文章分类',
  tags: ['cms'],
  params: categoryParams,
  body: articleCategoryForm,
  response: articleCategorySchema,
  errors: ['CMS_CATEGORY_NOT_FOUND', 'CMS_CATEGORY_TOO_DEEP', 'CMS_CATEGORY_CYCLE'],
  examples: [
    {
      name: 'rename',
      params: { id: '3' },
      body: { title: '新闻资讯', intro: '商城公告与行业动态', sortOrder: 10 },
      response: articleCategoryExample,
    },
  ],
});

export const cmsCategorySetStatus = defineRoute({
  id: 'cms.adminCategorySetStatus',
  method: 'POST',
  path: '/admin-api/cms/article-categories/:id/status',
  auth: 'admin',
  permission: 'cms:category:write',
  summary: '显示/隐藏文章分类',
  tags: ['cms'],
  params: categoryParams,
  body: articleCategoryStatusBody,
  response: articleCategorySchema,
  errors: ['CMS_CATEGORY_NOT_FOUND'],
  examples: [
    {
      name: 'hide',
      params: { id: '3' },
      body: { status: 'hidden' },
      response: { ...articleCategoryExample, status: 'hidden' },
    },
  ],
});

export const cmsCategoryDelete = defineRoute({
  id: 'cms.adminCategoryDelete',
  method: 'DELETE',
  path: '/admin-api/cms/article-categories/:id',
  auth: 'admin',
  permission: 'cms:category:write',
  summary: '删除文章分类',
  tags: ['cms'],
  params: categoryParams,
  response: z.object({ deleted: z.literal(true) }),
  errors: ['CMS_CATEGORY_NOT_FOUND', 'CMS_CATEGORY_NOT_EMPTY'],
  examples: [{ name: 'ok', params: { id: '9' }, response: { deleted: true } }],
});
