import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  pagedProductCategories,
  productCategory,
  productCategoryChildExample,
  productCategoryExample,
  productCategoryForm,
  productCategoryListQuery,
  productCategoryNodeExample,
  productCategoryTree,
  productCategoryVisibilityBody,
} from './schemas';

/**
 * Admin category routes, `/admin-api/catalog/categories`.
 *
 * The domain owns the `catalog/**` segment on both surfaces rather than a bare
 * `categories/**`: "category" is a word three domains use (product categories,
 * article categories, attachment categories) and the App Router makes the
 * directory the URL, so an unqualified segment would be a collision waiting to
 * happen.
 */

const categoryParams = z.object({ id });

export const catalogAdminCategoryList = defineRoute({
  id: 'catalog.adminCategoryList',
  method: 'GET',
  path: '/admin-api/catalog/categories',
  auth: 'admin',
  permission: 'catalog:category:read',
  summary: '商品分类列表',
  tags: ['catalog'],
  query: productCategoryListQuery,
  response: pagedProductCategories,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: {
        items: [productCategoryExample, productCategoryChildExample],
        total: 2,
        page: 1,
        pageSize: 20,
      },
    },
    {
      name: 'children-of-7',
      query: { page: 1, pageSize: 20, parentId: '7' },
      response: { items: [productCategoryChildExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

/**
 * The whole tree in one call, for the cascader in the product form and for the
 * coupon / DIY pickers. Not paged: the tree is capped at three levels and a
 * shop with more than a few hundred categories has a different problem.
 */
export const catalogAdminCategoryTree = defineRoute({
  id: 'catalog.adminCategoryTree',
  method: 'GET',
  path: '/admin-api/catalog/category-tree',
  auth: 'admin',
  permission: 'catalog:category:read',
  summary: '商品分类树',
  tags: ['catalog'],
  query: z.object({
    /** Hidden categories are included by default so the editor can still reach them. */
    visibleOnly: z.stringbool().default(false),
  }),
  response: productCategoryTree,
  examples: [
    { name: 'tree', query: {}, response: { items: [productCategoryNodeExample] } },
    { name: 'visible-only', query: { visibleOnly: 'true' }, response: { items: [] } },
  ],
});

export const catalogAdminCategoryDetail = defineRoute({
  id: 'catalog.adminCategoryDetail',
  method: 'GET',
  path: '/admin-api/catalog/categories/:id',
  auth: 'admin',
  permission: 'catalog:category:read',
  summary: '商品分类详情',
  tags: ['catalog'],
  params: categoryParams,
  response: productCategory,
  errors: ['CATALOG_CATEGORY_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '7' }, response: productCategoryExample }],
});

export const catalogAdminCategoryCreate = defineRoute({
  id: 'catalog.adminCategoryCreate',
  method: 'POST',
  path: '/admin-api/catalog/categories',
  auth: 'admin',
  permission: 'catalog:category:write',
  summary: '新建商品分类',
  tags: ['catalog'],
  body: productCategoryForm,
  response: productCategory,
  status: 201,
  errors: ['CATALOG_CATEGORY_NOT_FOUND', 'CATALOG_CATEGORY_TOO_DEEP'],
  examples: [
    {
      name: 'root',
      body: { name: '男装', iconUrl: 'https://cdn.example.com/cate/men.png', sortOrder: 10 },
      response: productCategoryExample,
    },
    {
      name: 'child',
      body: { parentId: '7', name: 'T恤', sortOrder: 20 },
      response: productCategoryChildExample,
    },
  ],
});

export const catalogAdminCategoryUpdate = defineRoute({
  id: 'catalog.adminCategoryUpdate',
  method: 'PUT',
  path: '/admin-api/catalog/categories/:id',
  auth: 'admin',
  permission: 'catalog:category:write',
  summary: '编辑商品分类',
  tags: ['catalog'],
  params: categoryParams,
  body: productCategoryForm,
  response: productCategory,
  errors: ['CATALOG_CATEGORY_NOT_FOUND', 'CATALOG_CATEGORY_TOO_DEEP', 'CATALOG_CATEGORY_CYCLE'],
  examples: [
    {
      name: 'rename',
      params: { id: '7' },
      body: { name: '男士服装', iconUrl: 'https://cdn.example.com/cate/men.png', sortOrder: 10 },
      response: { ...productCategoryExample, name: '男士服装' },
    },
  ],
});

/** The list's 显示 switch. Its own sub-resource, its own audit entry. */
export const catalogAdminCategorySetVisibility = defineRoute({
  id: 'catalog.adminCategorySetVisibility',
  method: 'POST',
  path: '/admin-api/catalog/categories/:id/visibility',
  auth: 'admin',
  permission: 'catalog:category:write',
  summary: '显示/隐藏商品分类',
  tags: ['catalog'],
  params: categoryParams,
  body: productCategoryVisibilityBody,
  response: productCategory,
  errors: ['CATALOG_CATEGORY_NOT_FOUND'],
  examples: [
    {
      name: 'hide',
      params: { id: '7' },
      body: { isVisible: false },
      response: { ...productCategoryExample, isVisible: false },
    },
  ],
});

export const catalogAdminCategoryDelete = defineRoute({
  id: 'catalog.adminCategoryDelete',
  method: 'DELETE',
  path: '/admin-api/catalog/categories/:id',
  auth: 'admin',
  permission: 'catalog:category:write',
  summary: '删除商品分类',
  tags: ['catalog'],
  params: categoryParams,
  response: z.void(),
  status: 204,
  errors: ['CATALOG_CATEGORY_NOT_FOUND', 'CATALOG_CATEGORY_IN_USE'],
  examples: [{ name: 'ok', params: { id: '17' }, response: undefined }],
});
