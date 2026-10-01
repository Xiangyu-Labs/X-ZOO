import { z } from 'zod';
import { id, instant, pageQuery, paged, sortQuery } from '../_conventions/common';

/**
 * Shapes for the media library and the upload endpoints.
 *
 * The enums mirror the PostgreSQL enums in `db/src/schema/storage.ts`
 * (`attachments_driver`, `attachments_kind`) and are kept honest by
 * `storage.service.ts`, which assigns one to the other.
 *
 * **Nothing here accepts a storage key, a path or a URL to store under.** The
 * server picks the key, always; that was the `videoDataSave` defect.
 */

export const attachmentDriver = z.enum(['local', 's3']);
export type AttachmentDriver = z.infer<typeof attachmentDriver>;

export const attachmentKind = z.enum(['image', 'video', 'audio', 'file']);
export type AttachmentKind = z.infer<typeof attachmentKind>;

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

/**
 * The tree arrives **flat**, in depth-first display order, and the client nests
 * it by `parentId`. A self-referential zod schema is legal but blows the stack
 * in `zod-to-openapi`, and a flat list is what `CrudTable` and the picker's tree
 * both want anyway. `depth` and `path` are carried so nobody has to walk the
 * list twice to indent a row.
 */
export const attachmentCategoryNode = z.object({
  id,
  parentId: id.nullable(),
  name: z.string(),
  sortOrder: z.number().int(),
  /** 0 for a root category. */
  depth: z.number().int().min(0),
  /** Materialised ancestor path, `/1/7/`. Root categories have `/`. */
  path: z.string(),
  /** Direct members only; a parent does not count its children's files. */
  attachmentCount: z.number().int().min(0),
});
export type AttachmentCategoryNode = z.infer<typeof attachmentCategoryNode>;

export const attachmentCategoryTree = z.object({
  items: z.array(attachmentCategoryNode),
});

export const attachmentCategoryNodeExample: AttachmentCategoryNode = {
  id: '1',
  parentId: null,
  name: '商品图',
  sortOrder: 0,
  depth: 0,
  path: '/',
  attachmentCount: 42,
};

export const attachmentCategoryChildExample: AttachmentCategoryNode = {
  id: '7',
  parentId: '1',
  name: '详情页',
  sortOrder: 0,
  depth: 1,
  path: '/1/',
  attachmentCount: 18,
};

export const attachmentCategoryForm = z.object({
  name: z.string().trim().min(1, '请填写分类名称').max(64),
  parentId: id.nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type AttachmentCategoryForm = z.infer<typeof attachmentCategoryForm>;

/** A category row as returned after a write. */
export const attachmentCategory = z.object({
  id,
  parentId: id.nullable(),
  name: z.string(),
  sortOrder: z.number().int(),
});
export type AttachmentCategory = z.infer<typeof attachmentCategory>;

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

export const attachmentItem = z.object({
  id,
  categoryId: id.nullable(),
  /** Renderable URL. Site-relative for the local driver, absolute for S3. */
  url: z.string(),
  name: z.string(),
  originalName: z.string().nullable(),
  kind: attachmentKind,
  mime: z.string(),
  size: z.number().int().min(0),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  driver: attachmentDriver,
  /** Lower-case hex sha256 of the stored bytes; the dedupe key. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: instant,
});
export type AttachmentItem = z.infer<typeof attachmentItem>;

export const attachmentItemExample: AttachmentItem = {
  id: '100',
  categoryId: '7',
  url: '/uploads/attachment/2026/09/2f8c1d9b4a7e4c1f9d0b6a3e5c2f7a10.png',
  name: '首页 banner',
  originalName: 'banner.png',
  kind: 'image',
  mime: 'image/png',
  size: 48213,
  width: 750,
  height: 390,
  durationMs: null,
  driver: 'local',
  sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  createdAt: '2026-09-21T15:20:00+08:00',
};

export const attachmentListQuery = pageQuery
  .extend({
    categoryId: id.optional(),
    /** `true` includes descendant categories. Ignored without `categoryId`. */
    includeSubcategories: z.stringbool().default(false),
    keyword: z.string().trim().max(128).optional(),
    kind: attachmentKind.optional(),
  })
  .extend(sortQuery(['id', 'createdAt', 'size', 'name']).shape);
export type AttachmentListQuery = z.infer<typeof attachmentListQuery>;

export const pagedAttachments = paged(attachmentItem);

/** Rename and re-file. Never the storage key, the URL, the mime or the size. */
export const attachmentUpdateBody = z.object({
  name: z.string().trim().min(1, '请填写名称').max(255),
  categoryId: id.nullable().optional(),
});
export type AttachmentUpdateBody = z.infer<typeof attachmentUpdateBody>;

export const attachmentIdsBody = z.object({
  ids: z.array(id).min(1, '请选择要操作的素材').max(200),
});
export type AttachmentIdsBody = z.infer<typeof attachmentIdsBody>;

export const attachmentMoveBody = attachmentIdsBody.extend({
  categoryId: id.nullable(),
});
export type AttachmentMoveBody = z.infer<typeof attachmentMoveBody>;

export const attachmentBatchResult = z.object({
  affected: z.number().int().min(0),
  /** Ids that were already gone. Not an error: two operators, one list. */
  skippedIds: z.array(id),
});
export type AttachmentBatchResult = z.infer<typeof attachmentBatchResult>;

/**
 * Query of an upload. The file itself is a `multipart/form-data` part named
 * `file`, which is why there is no `body` schema on the upload routes: the
 * request never carries JSON.
 */
export const uploadQuery = z.object({
  categoryId: id.optional(),
  /**
   * Logical folder inside the bucket, sanitised to `[a-z0-9-]` by the storage
   * port. A hint, not a path — `../` and absolute paths cannot survive it.
   */
  directory: z.string().trim().max(32).optional(),
});
export type UploadQuery = z.infer<typeof uploadQuery>;

/** What an upload answers with, plus whether the bytes were already there. */
export const uploadResult = z.object({
  attachment: attachmentItem,
  /**
   * `true` when an attachment with the same sha256 already existed and was
   * returned instead of storing the bytes twice.
   */
  deduped: z.boolean(),
});
export type UploadResult = z.infer<typeof uploadResult>;

export const uploadResultExample: UploadResult = {
  attachment: attachmentItemExample,
  deduped: false,
};

// ---------------------------------------------------------------------------
// remote import
// ---------------------------------------------------------------------------

/**
 * Importing a picture by URL — the `onlineUpload` successor.
 *
 * The URL is fetched through `core/src/storage/safe-fetch.ts`, which resolves
 * DNS itself and refuses private, loopback, link-local, multicast and cloud
 * metadata addresses *after* resolution and again on every redirect. The old
 * endpoint did none of that.
 */
export const attachmentImportBody = z.object({
  url: z.url('请填写合法的 http(s) 地址').max(2048),
  categoryId: id.nullable().optional(),
  name: z.string().trim().max(255).optional(),
});
export type AttachmentImportBody = z.infer<typeof attachmentImportBody>;

// ---------------------------------------------------------------------------
// phone-scan upload
// ---------------------------------------------------------------------------

/**
 * Scan-to-upload.
 *
 * A token is minted per admin, is single-use, short-lived, and the attachment
 * it produces is owned by the admin who minted it. One shared token would let
 * any scan by anybody upload into whoever asked last.
 */
export const scanToken = z.object({
  token: z.string(),
  /** The URL to put in the QR code; opens the mobile upload page. */
  url: z.string(),
  expiresAt: instant,
});
export type ScanToken = z.infer<typeof scanToken>;

export const scanTokenExample: ScanToken = {
  token: 'sJ9vQx2mR7pL4nT8wK1cF6hB3dZ5aY0e',
  url: 'https://shop.example.com/scan-upload/sJ9vQx2mR7pL4nT8wK1cF6hB3dZ5aY0e',
  expiresAt: '2026-09-22T09:10:00+08:00',
};

export const scanTokenParams = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, '扫码令牌不合法'),
});

export const scanTokenStatus = z.object({
  /** `pending` until a phone uploads, then `used`. `expired` after the TTL. */
  state: z.enum(['pending', 'used', 'expired']),
  attachment: attachmentItem.nullable(),
});
export type ScanTokenStatus = z.infer<typeof scanTokenStatus>;

// ---------------------------------------------------------------------------
// storefront upload
// ---------------------------------------------------------------------------

/** Where a shopper's upload is allowed to go. Anything else is refused. */
/**
 * What the shopper is uploading, and therefore where it lands and how big it
 * may be.
 */
export const userUploadPurpose = z.enum(['avatar', 'review', 'refund']);
export type UserUploadPurpose = z.infer<typeof userUploadPurpose>;

export const userUploadQuery = z.object({ purpose: userUploadPurpose });
export type UserUploadQuery = z.infer<typeof userUploadQuery>;

/** The shopper never sees the library's internals: just the renderable file. */
export const userUploadResult = z.object({
  url: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().min(0),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});
export type UserUploadResult = z.infer<typeof userUploadResult>;

export const userUploadResultExample: UserUploadResult = {
  url: '/uploads/review/2026/09/7c3a1f8e9d2b4a6c8e0f1a2b3c4d5e6f.jpg',
  name: '7c3a1f8e9d2b4a6c8e0f1a2b3c4d5e6f.jpg',
  mime: 'image/jpeg',
  size: 208431,
  width: 1080,
  height: 1440,
};
