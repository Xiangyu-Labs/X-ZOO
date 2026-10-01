import { z } from 'zod';

import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  decorDocumentDetailExample,
  decorDocumentExample,
  decorDocumentSummaryExample,
  revisionSummaryExample,
} from './examples';
import {
  createDecorDocumentBody,
  decorDocumentDetail,
  decorDocumentListQuery,
  decorDocumentSummary,
  designateBody,
  designationParams,
  designationsResponse,
  duplicateDecorDocumentBody,
  pagedDecorDocuments,
  previewTokenResponse,
  publishBody,
  publishResponse,
  renameDecorDocumentBody,
  revisionDetail,
  revisionParams,
  revisionSummary,
  rollbackBody,
  saveDraftBody,
  saveDraftResponse,
} from './schemas';

/**
 * 页面装修 v2 — the admin surface (docs/mini/decor.md).
 *
 * A document has one editable draft (optimistically locked by `version`) and
 * an append-only list of published revisions; the storefront serves the one
 * the document points at. Publishing and rolling back each add a revision.
 * Which document is the 首页 / 个人中心 is a designation, set separately.
 *
 * Permissions: `decor:page:read` to look, `decor:page:write` to edit drafts,
 * `decor:page:publish` for anything that changes what shoppers see.
 */

const documentParams = z.object({ id });

export const decorDocumentList = defineRoute({
  id: 'decor.adminDocumentList',
  method: 'GET',
  path: '/admin-api/decor/documents',
  auth: 'admin',
  permission: 'decor:page:read',
  summary: '装修页面列表',
  tags: ['decor'],
  query: decorDocumentListQuery,
  response: pagedDecorDocuments,
  examples: [
    {
      name: 'ok',
      query: { page: 1, pageSize: 20 },
      response: { items: [decorDocumentSummaryExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const decorDocumentGet = defineRoute({
  id: 'decor.adminDocumentGet',
  method: 'GET',
  path: '/admin-api/decor/documents/:id',
  auth: 'admin',
  permission: 'decor:page:read',
  summary: '装修页面详情（含草稿）',
  tags: ['decor'],
  params: documentParams,
  response: decorDocumentDetail,
  errors: ['DECOR_DOCUMENT_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '7' }, response: decorDocumentDetailExample }],
});

export const decorDocumentCreate = defineRoute({
  id: 'decor.adminDocumentCreate',
  method: 'POST',
  path: '/admin-api/decor/documents',
  auth: 'admin',
  permission: 'decor:page:write',
  summary: '新建装修页面',
  tags: ['decor'],
  body: createDecorDocumentBody,
  response: decorDocumentDetail,
  status: 201,
  errors: ['DECOR_DOCUMENT_INVALID'],
  examples: [
    {
      name: 'empty',
      body: { kind: 'custom', name: '国庆专题' },
      response: {
        ...decorDocumentDetailExample,
        id: '8',
        kind: 'custom',
        name: '国庆专题',
        title: '国庆专题',
        designation: null,
        draftVersion: '1',
        published: null,
        hasUnpublishedChanges: true,
        draft: {
          schemaVersion: 2,
          root: {
            props: { title: '国庆专题', background: '#f5f5f5', shareEnabled: true, shareTitle: '' },
          },
          blocks: [],
        },
      },
    },
  ],
});

export const decorDocumentRename = defineRoute({
  id: 'decor.adminDocumentRename',
  method: 'PATCH',
  path: '/admin-api/decor/documents/:id',
  auth: 'admin',
  permission: 'decor:page:write',
  summary: '重命名装修页面',
  tags: ['decor'],
  params: documentParams,
  body: renameDecorDocumentBody,
  response: decorDocumentSummary,
  errors: ['DECOR_DOCUMENT_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      params: { id: '7' },
      body: { name: '双十一首页' },
      response: { ...decorDocumentSummaryExample, name: '双十一首页' },
    },
  ],
});

/** Copies the draft into a new, unpublished, undesignated document of the same kind. */
export const decorDocumentDuplicate = defineRoute({
  id: 'decor.adminDocumentDuplicate',
  method: 'POST',
  path: '/admin-api/decor/documents/:id/duplicate',
  auth: 'admin',
  permission: 'decor:page:write',
  summary: '复制装修页面',
  tags: ['decor'],
  params: documentParams,
  body: duplicateDecorDocumentBody,
  response: decorDocumentDetail,
  status: 201,
  errors: ['DECOR_DOCUMENT_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      params: { id: '7' },
      body: {},
      response: {
        ...decorDocumentDetailExample,
        id: '9',
        name: '国庆首页 副本',
        designation: null,
        draftVersion: '1',
        published: null,
        hasUnpublishedChanges: true,
      },
    },
  ],
});

/** Soft delete. The current 首页 / 个人中心 cannot be deleted; its revisions are kept. */
export const decorDocumentDelete = defineRoute({
  id: 'decor.adminDocumentDelete',
  method: 'DELETE',
  path: '/admin-api/decor/documents/:id',
  auth: 'admin',
  permission: 'decor:page:write',
  summary: '删除装修页面',
  tags: ['decor'],
  params: documentParams,
  response: z.void(),
  status: 204,
  errors: ['DECOR_DOCUMENT_NOT_FOUND', 'DECOR_DOCUMENT_IN_USE'],
  examples: [{ name: 'ok', params: { id: '8' }, response: undefined }],
});

/**
 * Saves the draft. The envelope must check (else `DECOR_DOCUMENT_INVALID`,
 * nothing written); content issues are saved and returned, and block only
 * publishing. `version` must be the token the editor loaded.
 */
export const decorDraftSave = defineRoute({
  id: 'decor.adminDraftSave',
  method: 'PUT',
  path: '/admin-api/decor/documents/:id/draft',
  auth: 'admin',
  permission: 'decor:page:write',
  summary: '保存草稿',
  tags: ['decor'],
  params: documentParams,
  body: saveDraftBody,
  response: saveDraftResponse,
  errors: ['DECOR_DOCUMENT_NOT_FOUND', 'DECOR_VERSION_CONFLICT', 'DECOR_DOCUMENT_INVALID'],
  examples: [
    {
      name: 'ok',
      params: { id: '7' },
      body: { document: decorDocumentExample, version: '12' },
      response: { version: '13', issues: [], warnings: [], updatedAt: '2026-09-23T10:02:00+08:00' },
    },
  ],
});

/** Publishes the draft as a new revision and makes it live, atomically. */
export const decorPublish = defineRoute({
  id: 'decor.adminPublish',
  method: 'POST',
  path: '/admin-api/decor/documents/:id/publish',
  auth: 'admin',
  permission: 'decor:page:publish',
  summary: '发布页面',
  tags: ['decor'],
  params: documentParams,
  body: publishBody,
  response: publishResponse,
  errors: [
    'DECOR_DOCUMENT_NOT_FOUND',
    'DECOR_VERSION_CONFLICT',
    'DECOR_DOCUMENT_INVALID',
    'DECOR_NOTHING_TO_PUBLISH',
  ],
  examples: [
    {
      name: 'ok',
      params: { id: '7' },
      body: { version: '12', note: '国庆活动' },
      response: {
        document: decorDocumentSummaryExample,
        revision: revisionSummaryExample,
        warnings: [],
      },
    },
  ],
});

export const decorRevisionList = defineRoute({
  id: 'decor.adminRevisionList',
  method: 'GET',
  path: '/admin-api/decor/documents/:id/revisions',
  auth: 'admin',
  permission: 'decor:page:read',
  summary: '发布记录',
  tags: ['decor'],
  params: documentParams,
  response: z.object({ items: z.array(revisionSummary) }),
  errors: ['DECOR_DOCUMENT_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '7' }, response: { items: [revisionSummaryExample] } }],
});

export const decorRevisionGet = defineRoute({
  id: 'decor.adminRevisionGet',
  method: 'GET',
  path: '/admin-api/decor/documents/:id/revisions/:number',
  auth: 'admin',
  permission: 'decor:page:read',
  summary: '发布版本内容',
  tags: ['decor'],
  params: revisionParams,
  response: revisionDetail,
  errors: ['DECOR_DOCUMENT_NOT_FOUND', 'DECOR_REVISION_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      params: { id: '7', number: '3' },
      response: { ...revisionSummaryExample, content: decorDocumentExample },
    },
  ],
});

/**
 * Rolls back by publishing an old revision's content again, as a new revision
 * (`restoredFrom` set). History is never rewritten, and the draft is left
 * alone: the editor offers to load the restored content if wanted.
 */
export const decorRollback = defineRoute({
  id: 'decor.adminRollback',
  method: 'POST',
  path: '/admin-api/decor/documents/:id/revisions/:number/rollback',
  auth: 'admin',
  permission: 'decor:page:publish',
  summary: '回滚到此版本',
  tags: ['decor'],
  params: revisionParams,
  body: rollbackBody,
  response: publishResponse,
  errors: ['DECOR_DOCUMENT_NOT_FOUND', 'DECOR_REVISION_NOT_FOUND', 'DECOR_DOCUMENT_INVALID'],
  examples: [
    {
      name: 'ok',
      params: { id: '7', number: '2' },
      body: {},
      response: {
        document: { ...decorDocumentSummaryExample, hasUnpublishedChanges: true },
        revision: { ...revisionSummaryExample, id: '42', number: 4, note: '', restoredFrom: 2 },
        warnings: [],
      },
    },
  ],
});

/** A short-lived token to preview this document's draft on a device. */
export const decorPreviewToken = defineRoute({
  id: 'decor.adminPreviewToken',
  method: 'POST',
  path: '/admin-api/decor/documents/:id/preview-token',
  auth: 'admin',
  permission: 'decor:page:read',
  summary: '生成预览链接',
  tags: ['decor'],
  params: documentParams,
  response: previewTokenResponse,
  status: 201,
  errors: ['DECOR_DOCUMENT_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      params: { id: '7' },
      response: {
        previewToken: 'q7Hk2xVbN0aLr9sE4tYwUc1mZpD8fJgA3iKoT6vX5eR',
        expiresAt: '2026-09-23T10:15:00+08:00',
      },
    },
  ],
});

export const decorDesignations = defineRoute({
  id: 'decor.adminDesignations',
  method: 'GET',
  path: '/admin-api/decor/designations',
  auth: 'admin',
  permission: 'decor:page:read',
  summary: '当前首页与个人中心',
  tags: ['decor'],
  response: designationsResponse,
  examples: [{ name: 'ok', response: { home: decorDocumentSummaryExample, user_center: null } }],
});

/**
 * Makes a published document of the matching kind the 首页 or 个人中心, taking
 * the designation from whichever document had it. `documentId: null` clears
 * it (the 个人中心 then falls back to the built-in page; the storefront home
 * page answers `DECOR_HOME_NOT_SET`).
 */
export const decorDesignate = defineRoute({
  id: 'decor.adminDesignate',
  method: 'PUT',
  path: '/admin-api/decor/designations/:designation',
  auth: 'admin',
  permission: 'decor:page:publish',
  summary: '设为首页 / 个人中心',
  tags: ['decor'],
  params: designationParams,
  body: designateBody,
  response: designationsResponse,
  errors: ['DECOR_DOCUMENT_NOT_FOUND', 'DECOR_KIND_MISMATCH', 'DECOR_NOT_PUBLISHED'],
  examples: [
    {
      name: 'ok',
      params: { designation: 'home' },
      body: { documentId: '7' },
      response: { home: decorDocumentSummaryExample, user_center: null },
    },
  ],
});
