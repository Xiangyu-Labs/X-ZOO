/**
 * `@shop/core/decor` — 页面装修 v2 (plan §2.1, docs/mini/decor.md).
 *
 * The document model — blocks, links, data sources, validation —
 * lives in `@shop/contracts/decor/*`; this domain stores documents, publishes
 * revisions and resolves pages for the storefront.
 *
 * | Function              | Caller | When                                                      |
 * | --------------------- | ------ | --------------------------------------------------------- |
 * | `resolveHome`         | route  | `GET /api/v1/pages/home`                                  |
 * | `resolveUserCenter`   | route  | `GET /api/v1/pages/user-center` (built-in page if none)   |
 * | `resolveDocument`     | route  | `GET /api/v1/pages/:id`, `?previewToken=` for the draft   |
 * | the admin functions   | route  | `/admin-api/decor/**`, behind `decor:page:*`              |
 *
 * Every function takes `(ctx, input)`. Nothing here joins another domain's
 * transaction: a page is never written as part of an order or a payment. The
 * resolver reads other domains only through their `index.ts`.
 */

export { decorPermissions } from './permissions';

export {
  createDocument,
  createPreviewToken,
  deleteDocument,
  designate,
  duplicateDocument,
  getDesignations,
  getDocument,
  getRevision,
  listDocuments,
  listRevisions,
  publish,
  renameDocument,
  rollback,
  saveDraft,
} from './decor-document.service';

export {
  blockVisibleTo,
  resolveDocument,
  resolveHome,
  resolveUserCenter,
  type ResolveInput,
  type ResolveOptions,
} from './decor-resolve.service';

export { defaultResolvers, toProductSummary, type DataResolvers } from './decor.resolvers';
export { DECOR_CACHE_SECONDS, revisionCacheKey } from './decor.cache';
export { PREVIEW_TOKEN_SECONDS } from './decor.preview';
