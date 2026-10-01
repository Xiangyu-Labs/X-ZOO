import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  attachmentBatchResult,
  attachmentCategory,
  attachmentCategoryChildExample,
  attachmentCategoryForm,
  attachmentCategoryNodeExample,
  attachmentCategoryTree,
  attachmentIdsBody,
  attachmentImportBody,
  attachmentItem,
  attachmentItemExample,
  attachmentListQuery,
  attachmentMoveBody,
  attachmentUpdateBody,
  pagedAttachments,
  scanToken,
  scanTokenExample,
  scanTokenParams,
  scanTokenStatus,
  uploadQuery,
  uploadResult,
  uploadResultExample,
} from './schemas';

/**
 * The media library, `/admin-api/attachments` and `/admin-api/attachment-categories`.
 *
 * These are the routes behind the admin kit's `AssetSource`: `listCategories`
 * is the tree, `listAssets` is the list, `upload` is the POST and `remove` is
 * the deletions sub-resource. The picker is built against that interface, not
 * against the routes.
 *
 * **The upload routes declare no `body` schema.** The request is
 * `multipart/form-data` with one part named `file`; `handle()` only parses JSON
 * bodies, so the route reads the form itself and hands the bytes to the service.
 * Everything a caller *may* choose — category, logical directory — is a query
 * parameter. The storage key is never one of them.
 */

const attachmentParams = z.object({ id });

export const storageCategoryTree = defineRoute({
  id: 'storage.categoryTree',
  method: 'GET',
  path: '/admin-api/attachment-categories',
  auth: 'admin',
  permission: 'storage:category:read',
  summary: '素材分类树',
  tags: ['storage'],
  response: attachmentCategoryTree,
  examples: [
    {
      name: 'ok',
      response: { items: [attachmentCategoryNodeExample, attachmentCategoryChildExample] },
    },
  ],
});

export const storageCategoryCreate = defineRoute({
  id: 'storage.categoryCreate',
  method: 'POST',
  path: '/admin-api/attachment-categories',
  auth: 'admin',
  permission: 'storage:category:write',
  summary: '新建素材分类',
  tags: ['storage'],
  body: attachmentCategoryForm,
  response: attachmentCategory,
  status: 201,
  errors: ['STORAGE_CATEGORY_INVALID_PARENT'],
  examples: [
    {
      name: 'child',
      body: { name: '详情页', parentId: '1', sortOrder: 0 },
      response: { id: '7', parentId: '1', name: '详情页', sortOrder: 0 },
    },
  ],
});

export const storageCategoryUpdate = defineRoute({
  id: 'storage.categoryUpdate',
  method: 'PUT',
  path: '/admin-api/attachment-categories/:id',
  auth: 'admin',
  permission: 'storage:category:write',
  summary: '编辑素材分类',
  tags: ['storage'],
  params: attachmentParams,
  body: attachmentCategoryForm,
  response: attachmentCategory,
  errors: ['STORAGE_CATEGORY_NOT_FOUND', 'STORAGE_CATEGORY_INVALID_PARENT'],
  examples: [
    {
      name: 'rename',
      params: { id: '7' },
      body: { name: '详情长图', parentId: '1', sortOrder: 1 },
      response: { id: '7', parentId: '1', name: '详情长图', sortOrder: 1 },
    },
  ],
});

export const storageCategoryDelete = defineRoute({
  id: 'storage.categoryDelete',
  method: 'DELETE',
  path: '/admin-api/attachment-categories/:id',
  auth: 'admin',
  permission: 'storage:category:delete',
  summary: '删除素材分类',
  tags: ['storage'],
  params: attachmentParams,
  response: z.void(),
  status: 204,
  errors: ['STORAGE_CATEGORY_NOT_FOUND', 'STORAGE_CATEGORY_NOT_EMPTY'],
  examples: [{ name: 'ok', params: { id: '7' }, response: undefined }],
});

export const storageAttachmentList = defineRoute({
  id: 'storage.attachmentList',
  method: 'GET',
  path: '/admin-api/attachments',
  auth: 'admin',
  permission: 'storage:attachment:read',
  summary: '素材列表',
  tags: ['storage'],
  query: attachmentListQuery,
  response: pagedAttachments,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20, includeSubcategories: 'false' },
      response: { items: [attachmentItemExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'one-category-and-below',
      query: {
        page: 1,
        pageSize: 40,
        categoryId: '1',
        includeSubcategories: 'true',
        kind: 'image',
      },
      response: { items: [attachmentItemExample], total: 1, page: 1, pageSize: 40 },
    },
  ],
});

export const storageAttachmentUpdate = defineRoute({
  id: 'storage.attachmentUpdate',
  method: 'PUT',
  path: '/admin-api/attachments/:id',
  auth: 'admin',
  permission: 'storage:attachment:write',
  summary: '重命名/移动素材',
  tags: ['storage'],
  params: attachmentParams,
  body: attachmentUpdateBody,
  response: attachmentItem,
  errors: ['STORAGE_ATTACHMENT_NOT_FOUND', 'STORAGE_CATEGORY_NOT_FOUND'],
  examples: [
    {
      name: 'rename',
      params: { id: '100' },
      body: { name: '首页 banner（秋季）', categoryId: '7' },
      response: { ...attachmentItemExample, name: '首页 banner（秋季）' },
    },
  ],
});

export const storageAttachmentUpload = defineRoute({
  id: 'storage.attachmentUpload',
  method: 'POST',
  path: '/admin-api/attachments',
  auth: 'admin',
  permission: 'storage:attachment:write',
  summary: '上传素材（multipart）',
  tags: ['storage'],
  query: uploadQuery,
  response: uploadResult,
  status: 201,
  errors: [
    'STORAGE_NO_FILE',
    'STORAGE_UPLOAD_FIELD_MISSING',
    'STORAGE_FILE_TOO_LARGE',
    'STORAGE_FILE_TYPE_REJECTED',
    'STORAGE_MIME_MISMATCH',
    'STORAGE_CATEGORY_NOT_FOUND',
    'STORAGE_WRITE_FAILED',
  ],
  examples: [
    { name: 'stored', query: { categoryId: '7' }, response: uploadResultExample },
    {
      name: 'same-bytes-again',
      query: { categoryId: '7' },
      // The identical file was already in the library: one row, one object.
      response: { attachment: attachmentItemExample, deduped: true },
    },
  ],
});

export const storageAttachmentImport = defineRoute({
  id: 'storage.attachmentImport',
  method: 'POST',
  path: '/admin-api/attachments/imports',
  auth: 'admin',
  permission: 'storage:attachment:write',
  summary: '从网址导入素材',
  tags: ['storage'],
  body: attachmentImportBody,
  response: uploadResult,
  status: 201,
  errors: [
    'STORAGE_UPLOAD_RATE_LIMITED',
    'STORAGE_REMOTE_URL_REFUSED',
    'STORAGE_REMOTE_FETCH_FAILED',
    'STORAGE_FILE_TOO_LARGE',
    'STORAGE_FILE_TYPE_REJECTED',
    'STORAGE_CATEGORY_NOT_FOUND',
    'STORAGE_WRITE_FAILED',
  ],
  examples: [
    {
      name: 'from-a-public-cdn',
      body: { url: 'https://cdn.example.com/banner.png', categoryId: '7' },
      response: uploadResultExample,
    },
  ],
});

export const storageAttachmentDeleteMany = defineRoute({
  id: 'storage.attachmentDeleteMany',
  method: 'POST',
  path: '/admin-api/attachments/deletions',
  auth: 'admin',
  permission: 'storage:attachment:delete',
  summary: '批量删除素材',
  tags: ['storage'],
  body: attachmentIdsBody,
  response: attachmentBatchResult,
  examples: [
    {
      name: 'two-of-three-still-there',
      body: { ids: ['100', '101', '102'] },
      response: { affected: 2, skippedIds: ['102'] },
    },
  ],
});

export const storageAttachmentMoveMany = defineRoute({
  id: 'storage.attachmentMoveMany',
  method: 'POST',
  path: '/admin-api/attachments/moves',
  auth: 'admin',
  permission: 'storage:attachment:write',
  summary: '批量移动素材分类',
  tags: ['storage'],
  body: attachmentMoveBody,
  response: attachmentBatchResult,
  errors: ['STORAGE_CATEGORY_NOT_FOUND'],
  examples: [
    {
      name: 'into-a-category',
      body: { ids: ['100', '101'], categoryId: '7' },
      response: { affected: 2, skippedIds: [] },
    },
    {
      name: 'out-of-every-category',
      body: { ids: ['100'], categoryId: null },
      response: { affected: 1, skippedIds: [] },
    },
  ],
});

// ---------------------------------------------------------------------------
// scan-to-upload
// ---------------------------------------------------------------------------

export const storageScanTokenCreate = defineRoute({
  id: 'storage.scanTokenCreate',
  method: 'POST',
  path: '/admin-api/attachments/scan-tokens',
  auth: 'admin',
  permission: 'storage:attachment:write',
  summary: '生成扫码上传二维码',
  tags: ['storage'],
  query: uploadQuery,
  response: scanToken,
  status: 201,
  examples: [{ name: 'ok', query: { categoryId: '7' }, response: scanTokenExample }],
});

export const storageScanTokenStatus = defineRoute({
  id: 'storage.scanTokenStatus',
  method: 'GET',
  path: '/admin-api/attachments/scan-tokens/:token',
  auth: 'admin',
  permission: 'storage:attachment:write',
  summary: '轮询扫码上传结果',
  tags: ['storage'],
  params: scanTokenParams,
  response: scanTokenStatus,
  errors: ['STORAGE_SCAN_TOKEN_INVALID'],
  examples: [
    {
      name: 'waiting',
      params: { token: scanTokenExample.token },
      response: { state: 'pending', attachment: null },
    },
    {
      name: 'arrived',
      params: { token: scanTokenExample.token },
      response: { state: 'used', attachment: attachmentItemExample },
    },
  ],
});
