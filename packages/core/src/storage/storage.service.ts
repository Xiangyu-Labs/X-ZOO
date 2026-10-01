import type {
  AttachmentBatchResult,
  AttachmentCategory,
  AttachmentCategoryForm,
  AttachmentCategoryNode,
  AttachmentIdsBody,
  AttachmentImportBody,
  AttachmentItem,
  AttachmentListQuery,
  AttachmentMoveBody,
  AttachmentUpdateBody,
  ScanToken,
  ScanTokenStatus,
  UploadQuery,
  UploadResult,
  UserUploadPurpose,
  UserUploadResult,
} from '@shop/contracts/storage/schemas';
import {
  IMAGE_VARIANT_WIDTHS,
  imageVariantUrl,
  originalImageUrl,
} from '@shop/contracts/storage/image-variants';
import type { Tx } from '@shop/db';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { Ctx } from '../kernel/context';
import { requireAdminId, requireUserId } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId, toIdOrNull } from '../kernel/ids';
import { originFromEnv } from '../kernel/origin';
import { enforce, fixedWindow } from '../kernel/rate-limit';
import type { Storage } from '../kernel/storage';
import { isRejected, mimeAgrees, probeImageDimensions, sniffFileType } from './file-type';
import { safeFetch, SafeFetchError, type SafeFetchOptions } from './safe-fetch';
import { createS3Storage } from './s3';
import { createScanTokenStore } from './scan-token';
import * as repo from './storage.repo';
import { storageConfig } from './storage.config';

/**
 * The media library, and every door a file can come in through.
 *
 * Four things here are deliberate:
 *
 *  1. **the bytes decide the type.** `sniffFileType` reads the magic bytes and
 *     an allow-list decides; the client's `Content-Type` is only ever compared
 *     against the answer. HTML, SVG, PHP and executables are refused before the
 *     allow-list is even consulted.
 *  2. **the server picks the key.** `Storage.put` generates it. Nothing in any
 *     request reaches a path.
 *  3. **remote imports go through `safeFetch`**, which resolves DNS itself and
 *     judges every resolved address, on the first request and on each redirect.
 *  4. **scan tokens are per-admin and single-use**, claimed by an atomic Redis
 *     script rather than kept under one global cache key.
 *
 * Deleting is a *soft* delete. A product description written three years ago
 * may still reference the file, so the row is tombstoned and `cleanOrphans`
 * sweeps the bytes after `storage.orphanRetentionDays`.
 */

// ---------------------------------------------------------------------------
// driver resolution
// ---------------------------------------------------------------------------

export interface ResolvedStorage {
  storage: Storage;
  driver: 'local' | 's3';
  bucket: string | null;
}

/**
 * The driver named by the `storage` config group.
 *
 * `ctx.storage` is built from the environment by the container and is always
 * the local driver; the *configured* driver is a runtime setting an operator
 * changes on the settings screen. So: `local` uses `ctx.storage` unchanged, and
 * `s3` is constructed here from the group's values, so
 * `apps/web/src/server/container.ts` never needs to know about the setting.
 *
 * The S3 client is memoised on its own settings, because building one per
 * upload would re-derive nothing expensive but would still be silly.
 */
let s3Cache: { signature: string; storage: Storage } | null = null;

export async function resolveStorage(ctx: Ctx): Promise<ResolvedStorage> {
  const settings = await ctx.config.get(storageConfig);
  if (settings.driver === 'local') {
    return { storage: ctx.storage, driver: 'local', bucket: null };
  }

  const signature = [
    settings.s3Bucket,
    settings.s3Region,
    settings.s3Endpoint,
    settings.s3AccessKeyId,
    settings.s3PublicBaseUrl,
    settings.s3Addressing,
    // The secret takes part in the signature but never leaves this function.
    settings.s3SecretAccessKey.length > 0 ? 'set' : 'unset',
  ].join('|');

  if (!s3Cache || s3Cache.signature !== signature) {
    s3Cache = { signature, storage: s3StorageFor(ctx, settings) };
  }
  return { storage: s3Cache.storage, driver: 's3', bucket: settings.s3Bucket };
}

/**
 * An S3 client for a given set of `storage` values, not memoised — the stored
 * ones through `resolveStorage`, or the unsaved form 「测试」 runs against.
 */
export function s3StorageFor(
  ctx: Pick<Ctx, 'clock'>,
  settings: z.infer<typeof storageConfig.schema>,
): Storage {
  return createS3Storage({
    bucket: settings.s3Bucket,
    region: settings.s3Region,
    endpoint: settings.s3Endpoint === '' ? undefined : settings.s3Endpoint,
    accessKeyId: settings.s3AccessKeyId,
    secretAccessKey: settings.s3SecretAccessKey,
    publicBaseUrl: settings.s3PublicBaseUrl,
    addressing: settings.s3Addressing,
    now: () => ctx.clock.now(),
  });
}

/** Test helper: forgets the memoised S3 client. */
export function resetStorageDriverCache(): void {
  s3Cache = null;
}

// ---------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------

function toItem(row: repo.AttachmentRow): AttachmentItem {
  return {
    id: toId(row.id),
    categoryId: toIdOrNull(row.categoryId),
    url: row.url,
    name: row.name,
    originalName: row.originalName,
    kind: row.kind,
    mime: row.mime,
    size: Number(row.size),
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    driver: row.driver,
    sha256: row.sha256,
    createdAt: row.createdAt.toISOString(),
  };
}

function toCategory(row: repo.CategoryRow): AttachmentCategory {
  return {
    id: toId(row.id),
    parentId: toIdOrNull(row.parentId),
    name: row.name,
    sortOrder: row.sortOrder,
  };
}

/** `/` → 0, `/1/` → 1, `/1/7/` → 2. */
function depthOf(path: string): number {
  return path.split('/').filter((part) => part !== '').length;
}

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

/** Four levels is already one more than anybody files pictures into. */
const MAX_CATEGORY_DEPTH = 4;

export async function categoryTree(ctx: Ctx): Promise<{ items: AttachmentCategoryNode[] }> {
  const [rows, counts] = await Promise.all([
    repo.listCategories(ctx.db),
    repo.categoryAttachmentCounts(ctx.db),
  ]);

  const byParent = new Map<number | null, repo.CategoryRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parentId) ?? [];
    siblings.push(row);
    byParent.set(row.parentId, siblings);
  }

  // Depth-first, so the flat array is already in display order and the client
  // only has to indent by `depth`.
  const items: AttachmentCategoryNode[] = [];
  const walk = (parentId: number | null): void => {
    for (const row of byParent.get(parentId) ?? []) {
      items.push({
        id: toId(row.id),
        parentId: toIdOrNull(row.parentId),
        name: row.name,
        sortOrder: row.sortOrder,
        depth: depthOf(row.path),
        path: row.path,
        attachmentCount: counts.get(row.id) ?? 0,
      });
      walk(row.id);
    }
  };
  walk(null);
  return { items };
}

async function requireCategory(ctx: Ctx, id: number): Promise<repo.CategoryRow> {
  const row = await repo.findCategory(ctx.db, id);
  if (!row) throw new DomainError('STORAGE_CATEGORY_NOT_FOUND');
  return row;
}

/** Resolves and validates the optional parent of a category. */
async function resolveParent(
  ctx: Ctx,
  parentId: number | null,
): Promise<{ parentId: number | null; path: string }> {
  if (parentId === null) return { parentId: null, path: '/' };
  const parent = await repo.findCategory(ctx.db, parentId);
  if (!parent) throw new DomainError('STORAGE_CATEGORY_INVALID_PARENT');
  const path = `${parent.path}${parent.id}/`;
  if (depthOf(path) >= MAX_CATEGORY_DEPTH) {
    throw new DomainError('STORAGE_CATEGORY_INVALID_PARENT', {
      details: { maxDepth: MAX_CATEGORY_DEPTH },
    });
  }
  return { parentId: parent.id, path };
}

export async function categoryCreate(
  ctx: Ctx,
  form: AttachmentCategoryForm,
): Promise<AttachmentCategory> {
  const parentId =
    form.parentId === undefined || form.parentId === null ? null : fromId(form.parentId);
  const parent = await resolveParent(ctx, parentId);

  return ctx.withTx(async (tx) => {
    // A child is a thing filed into the parent, exactly like an attachment, and
    // the delete guard counts live children too. Same lock, same reason.
    if (parent.parentId !== null && !(await repo.lockCategoryAlive(tx, parent.parentId))) {
      throw new DomainError('STORAGE_CATEGORY_INVALID_PARENT');
    }
    if (await repo.categoryNameTaken(tx, parent.parentId, form.name)) {
      throw new DomainError('STORAGE_CATEGORY_INVALID_PARENT', {
        details: { reason: 'duplicate-name' },
      });
    }
    const row = await repo.insertCategory(tx, {
      parentId: parent.parentId,
      name: form.name,
      path: parent.path,
      sortOrder: form.sortOrder,
    });
    return toCategory(row);
  });
}

export async function categoryUpdate(
  ctx: Ctx,
  params: { id: string },
  form: AttachmentCategoryForm,
): Promise<AttachmentCategory> {
  const id = fromId(params.id);
  const current = await requireCategory(ctx, id);
  const nextParentId =
    form.parentId === undefined || form.parentId === null ? null : fromId(form.parentId);

  // A category cannot become its own descendant, and cannot be its own parent.
  if (nextParentId === id) throw new DomainError('STORAGE_CATEGORY_INVALID_PARENT');
  const subtree = await repo.descendantCategoryIds(ctx.db, current);
  if (nextParentId !== null && subtree.includes(nextParentId)) {
    throw new DomainError('STORAGE_CATEGORY_INVALID_PARENT', { details: { reason: 'cycle' } });
  }

  const parent = await resolveParent(ctx, nextParentId);
  if (await repo.categoryNameTaken(ctx.db, parent.parentId, form.name, id)) {
    throw new DomainError('STORAGE_CATEGORY_INVALID_PARENT', {
      details: { reason: 'duplicate-name' },
    });
  }
  // Moving a folder *down* takes its children with it, so the limit has to be
  // checked against the deepest leaf, not against the folder being moved.
  const shift = depthOf(parent.path) - depthOf(current.path);
  if (shift > 0 && subtree.length > 0) {
    const rows = await repo.listCategories(ctx.db);
    const deepest = rows
      .filter((row) => subtree.includes(row.id))
      .reduce((max, row) => Math.max(max, depthOf(row.path)), depthOf(current.path));
    if (deepest + shift >= MAX_CATEGORY_DEPTH) {
      throw new DomainError('STORAGE_CATEGORY_INVALID_PARENT', {
        details: { maxDepth: MAX_CATEGORY_DEPTH },
      });
    }
  }

  const now = ctx.clock.now();
  return ctx.withTx(async (tx) => {
    // Re-parenting files this folder into another one; the destination must not
    // be deleted out from under it. (Moving to the root needs no lock.)
    if (parent.parentId !== null && !(await repo.lockCategoryAlive(tx, parent.parentId))) {
      throw new DomainError('STORAGE_CATEGORY_INVALID_PARENT');
    }
    const result = await repo.updateCategory(
      tx,
      id,
      { parentId: parent.parentId, name: form.name, path: parent.path, sortOrder: form.sortOrder },
      now,
    );
    if (!result.won) throw new DomainError('STORAGE_CATEGORY_NOT_FOUND');
    if (parent.path !== current.path) {
      await repo.reparentSubtree(tx, `${current.path}${id}/`, `${parent.path}${id}/`, now);
    }
    const row = await repo.findCategory(tx, id);
    if (!row) throw new DomainError('STORAGE_CATEGORY_NOT_FOUND');
    return toCategory(row);
  });
}

export async function categoryDelete(ctx: Ctx, params: { id: string }): Promise<void> {
  const id = fromId(params.id);
  await requireCategory(ctx, id);
  const now = ctx.clock.now();

  // Two locks, in this order, because the emptiness guard spans two tables.
  //
  // `not exists (select … from attachments …)` inside the UPDATE serialises
  // this delete against another delete — but not against an upload, which
  // writes a *different* table: under READ COMMITTED neither transaction sees
  // the other's uncommitted row, both commit, and the picture lands in a
  // deleted folder where nobody can find it. So everything that files into a
  // category takes `FOR SHARE` on the category row first
  // (`repo.lockCategoryAlive`); this takes the conflicting `FOR UPDATE` and
  // only then runs the guarded update, as a separate statement so that it reads
  // a snapshot taken after the lock was granted.
  await ctx.withTx(async (tx) => {
    if (!(await repo.lockCategoryForDelete(tx, id))) {
      throw new DomainError('STORAGE_CATEGORY_NOT_FOUND');
    }
    const result = await repo.deleteCategoryIfEmpty(tx, id, now);
    if (!result.won) {
      const still = await repo.findCategory(tx, id);
      throw new DomainError(still ? 'STORAGE_CATEGORY_NOT_EMPTY' : 'STORAGE_CATEGORY_NOT_FOUND');
    }
  });
}

// ---------------------------------------------------------------------------
// listing and editing
// ---------------------------------------------------------------------------

export async function attachmentList(
  ctx: Ctx,
  query: AttachmentListQuery,
): Promise<{ items: AttachmentItem[]; total: number; page: number; pageSize: number }> {
  let categoryIds: number[] | undefined;
  if (query.categoryId !== undefined) {
    const id = fromId(query.categoryId);
    categoryIds = [id];
    if (query.includeSubcategories) {
      const current = await repo.findCategory(ctx.db, id);
      if (current) categoryIds = [id, ...(await repo.descendantCategoryIds(ctx.db, current))];
    }
  }

  const { items, total } = await repo.listAttachments(ctx.db, {
    categoryIds,
    keyword: query.keyword,
    kind: query.kind,
    sortBy: query.sortBy as repo.AttachmentListArgs['sortBy'],
    sortOrder: query.sortOrder,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return { items: items.map(toItem), total, page: query.page, pageSize: query.pageSize };
}

export async function attachmentUpdate(
  ctx: Ctx,
  params: { id: string },
  body: AttachmentUpdateBody,
): Promise<AttachmentItem> {
  const id = fromId(params.id);
  const categoryId =
    body.categoryId === undefined || body.categoryId === null ? null : fromId(body.categoryId);
  if (categoryId !== null) await requireCategory(ctx, categoryId);

  const result = await repo.updateAttachment(
    ctx.db,
    id,
    { name: body.name, categoryId },
    ctx.clock.now(),
  );
  if (!result.won) throw new DomainError('STORAGE_ATTACHMENT_NOT_FOUND');
  const row = await repo.findAttachment(ctx.db, id);
  if (!row) throw new DomainError('STORAGE_ATTACHMENT_NOT_FOUND');
  return toItem(row);
}

export async function attachmentDeleteMany(
  ctx: Ctx,
  body: AttachmentIdsBody,
): Promise<AttachmentBatchResult> {
  const ids = body.ids.map(fromId);
  const alive = await repo.aliveAttachmentIds(ctx.db, ids);
  const affected = await repo.softDeleteAttachments(ctx.db, [...alive], ctx.clock.now());
  return {
    affected,
    // Two operators, one list: an id that was already gone is reported, not an error.
    skippedIds: ids.filter((id) => !alive.has(id)).map(toId),
  };
}

export async function attachmentMoveMany(
  ctx: Ctx,
  body: AttachmentMoveBody,
): Promise<AttachmentBatchResult> {
  const categoryId = body.categoryId === null ? null : fromId(body.categoryId);
  if (categoryId !== null) await requireCategory(ctx, categoryId);
  const ids = body.ids.map(fromId);
  const now = ctx.clock.now();

  // Filing into a folder, so the same lock as an upload: a move and a delete of
  // the destination must not both succeed.
  return ctx.withTx(async (tx) => {
    if (categoryId !== null && !(await repo.lockCategoryAlive(tx, categoryId))) {
      throw new DomainError('STORAGE_CATEGORY_NOT_FOUND');
    }
    const alive = await repo.aliveAttachmentIds(tx, ids);
    const affected = await repo.moveAttachments(tx, [...alive], categoryId, now);
    return { affected, skippedIds: ids.filter((id) => !alive.has(id)).map(toId) };
  });
}

// ---------------------------------------------------------------------------
// storing bytes
// ---------------------------------------------------------------------------

export interface IncomingFile {
  bytes: Uint8Array;
  /** The client's filename. Used for the display name and nothing else. */
  filename: string | undefined;
  /** The client's `Content-Type`. Compared against the bytes, never trusted. */
  declaredMime: string | undefined;
}

/**
 * The file itself, or a reader handed the ceiling that applies, so the route
 * can refuse an oversized body before buffering it (`readFilePart`) and the
 * service reads it only after its own checks and budgets.
 */
export type FileSource = IncomingFile | ((maxBytes: number) => Promise<IncomingFile>);

const readSource = (file: FileSource, maxBytes: number): Promise<IncomingFile> =>
  typeof file === 'function' ? file(maxBytes) : Promise.resolve(file);

interface StoreArgs {
  file: IncomingFile;
  maxBytes: number;
  directory: string | undefined;
  categoryId: number | null;
  uploadedByAdminId: number | null;
  uploadedByUserId: number | null;
  name?: string | undefined;
  /** `image` only, for the storefront. */
  kinds?: readonly ('image' | 'video' | 'audio' | 'file')[] | undefined;
}

/**
 * Validate, store, dedupe, record. The single path every upload takes.
 *
 * The dedupe is a real conditional state change, so it is decided inside a
 * transaction under a **digest-scoped advisory lock** rather than by a read
 * followed by a hopeful insert. Two requests carrying identical bytes serialise
 * on `pg_advisory_xact_lock(hash(sha256))`: the first stores and inserts, the
 * second finds the row and returns `deduped: true`. Without the lock both see
 * "not there" and the library grows a twin every time somebody double-clicks.
 *
 * The lock is keyed on the digest, not taken globally, so unrelated uploads do
 * not queue behind each other.
 */
async function storeFile(ctx: Ctx, args: StoreArgs): Promise<UploadResult> {
  const { bytes } = args.file;
  if (bytes.byteLength === 0) throw new DomainError('STORAGE_NO_FILE');
  if (bytes.byteLength > args.maxBytes) {
    throw new DomainError('STORAGE_FILE_TOO_LARGE', {
      details: { maxBytes: args.maxBytes, size: bytes.byteLength },
    });
  }

  const sniffed = sniffFileType(bytes, args.file.declaredMime);
  if (isRejected(sniffed)) {
    ctx.logger.warn(
      { requestId: ctx.requestId, reason: sniffed.reason, size: bytes.byteLength },
      'storage: 拒绝上传的文件类型',
    );
    throw new DomainError('STORAGE_FILE_TYPE_REJECTED');
  }
  if (args.kinds && !args.kinds.includes(sniffed.kind)) {
    throw new DomainError('STORAGE_FILE_TYPE_REJECTED', { details: { detected: sniffed.kind } });
  }
  if (!mimeAgrees(args.file.declaredMime, sniffed.mime)) {
    throw new DomainError('STORAGE_MIME_MISMATCH', {
      details: { declared: args.file.declaredMime, detected: sniffed.mime },
    });
  }

  const digest = sha256Hex(bytes);
  const resolved = await resolveStorage(ctx);
  const dimensions = sniffed.kind === 'image' ? probeImageDimensions(bytes) : null;
  const displayName = (args.name ?? args.file.filename ?? '未命名文件').slice(0, 255);

  const result = await ctx.withTx(async (tx: Tx): Promise<UploadResult> => {
    // Before anything is written: hold the destination folder still. A folder
    // delete takes `FOR UPDATE` on this row, so either it waits for us and then
    // sees our attachment (and refuses as not-empty), or it committed first and
    // this returns null (and the upload is refused). The check above in
    // `attachmentUpload` is only there to answer quickly; this is the one that
    // decides. See `repo.lockCategoryAlive`.
    if (args.categoryId !== null && !(await repo.lockCategoryAlive(tx, args.categoryId))) {
      throw new DomainError('STORAGE_CATEGORY_NOT_FOUND');
    }
    await lockDigest(tx, digest);

    const existing = await repo.findByDigest(tx, digest, resolved.driver);
    if (existing) return { attachment: toItem(existing), deduped: true };

    let stored;
    try {
      stored = await resolved.storage.put(bytes, {
        directory: args.directory ?? 'attachment',
        filename: `x.${sniffed.extension}`,
        contentType: sniffed.mime,
      });
    } catch (error) {
      ctx.logger.error(
        { requestId: ctx.requestId, err: error, driver: resolved.driver },
        'storage: 写入失败',
      );
      throw new DomainError('STORAGE_WRITE_FAILED');
    }

    try {
      const row = await repo.insertAttachment(tx, {
        categoryId: args.categoryId,
        storageKey: stored.key,
        driver: resolved.driver,
        bucket: resolved.bucket,
        url: resolved.storage.url(stored.key),
        name: displayName,
        originalName: args.file.filename ?? null,
        kind: sniffed.kind,
        mime: sniffed.mime,
        size: stored.size,
        sha256: digest,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        durationMs: null,
        uploadedByAdminId: args.uploadedByAdminId,
        uploadedByUserId: args.uploadedByUserId,
      });
      return { attachment: toItem(row), deduped: false };
    } catch (error) {
      // The row is gone with the transaction; the object would not be. Best
      // effort, because failing the compensation must not mask the real error.
      await resolved.storage.delete(stored.key).catch(() => undefined);
      throw error;
    }
  });

  // After commit: the job reads the row, so it must not be able to run first.
  if (!result.deduped) await requestImageVariants(ctx, result.attachment);
  return result;
}

/** The worker job that writes an upload's thumbnails (`image-variants.ts`). */
export const GENERATE_IMAGE_VARIANTS_JOB = 'storage.generateImageVariants';

/**
 * Asks the worker for the 480 / 960 px variants of a freshly stored picture.
 * Fail soft: a queue that is down costs the thumbnails (the client falls back
 * to the original, and the backfill can fill them in later), never the upload.
 */
async function requestImageVariants(ctx: Ctx, attachment: AttachmentItem): Promise<void> {
  if (attachment.kind !== 'image') return;
  if (imageVariantUrl(attachment.url, IMAGE_VARIANT_WIDTHS[0]) === null) return;
  try {
    await ctx.queue.enqueue(
      GENERATE_IMAGE_VARIANTS_JOB,
      { attachmentId: attachment.id },
      { dedupeKey: `storage-variants:${attachment.id}` },
    );
  } catch (error) {
    ctx.logger.warn(
      { requestId: ctx.requestId, attachmentId: attachment.id, err: error },
      'storage: 缩略图任务入队失败，列表将使用原图',
    );
  }
}

/**
 * Transaction-scoped advisory lock keyed on the digest.
 *
 * `hashtextextended` turns the 64 hex characters into the `bigint` the lock
 * function wants. Released when the transaction ends, however it ends.
 */
async function lockDigest(tx: Tx, digest: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${digest}, 0))`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// the upload endpoints
// ---------------------------------------------------------------------------

export async function attachmentUpload(
  ctx: Ctx,
  query: UploadQuery,
  file: FileSource,
): Promise<UploadResult> {
  const adminId = requireAdminId(ctx);
  const settings = await ctx.config.get(storageConfig);
  const categoryId = query.categoryId === undefined ? null : fromId(query.categoryId);
  if (categoryId !== null) await requireCategory(ctx, categoryId);

  return storeFile(ctx, {
    file: await readSource(file, settings.maxUploadBytes),
    maxBytes: settings.maxUploadBytes,
    directory: query.directory ?? 'attachment',
    categoryId,
    uploadedByAdminId: adminId,
    uploadedByUserId: null,
  });
}

/**
 * 网址导入 per admin per hour. Far more than anybody pastes by hand, and far
 * less than a useful way to make the server knock on a thousand doors.
 */
export const REMOTE_IMPORTS_PER_HOUR = 120;

/**
 * Import by URL — the `onlineUpload` successor.
 *
 * Every refusal from `safeFetch` comes back as the same message, so the
 * endpoint cannot be used to map the internal network by timing or wording.
 */
export async function attachmentImport(
  ctx: Ctx,
  body: AttachmentImportBody,
  options: Pick<SafeFetchOptions, 'resolve' | 'transport'> = {},
): Promise<UploadResult> {
  const adminId = requireAdminId(ctx);
  const settings = await ctx.config.get(storageConfig);
  const categoryId =
    body.categoryId === undefined || body.categoryId === null ? null : fromId(body.categoryId);
  if (categoryId !== null) await requireCategory(ctx, categoryId);

  // The one endpoint that makes the server fetch an arbitrary URL gets a bucket
  // of its own, spent before any DNS lookup.
  await enforce(
    fixedWindow(ctx.redis, {
      key: `storage:import:admin:${adminId}`,
      limit: REMOTE_IMPORTS_PER_HOUR,
      windowMs: 60 * 60 * 1000,
      nowMs: ctx.clock.now().getTime(),
    }),
    'STORAGE_UPLOAD_RATE_LIMITED',
  );

  let fetched;
  try {
    fetched = await safeFetch(body.url, {
      maxBytes: settings.remoteImportMaxBytes,
      timeoutMs: settings.remoteImportTimeoutMs,
      allowHttp: settings.remoteImportAllowHttp,
      ...options,
    });
  } catch (error) {
    if (error instanceof SafeFetchError) {
      ctx.logger.warn(
        { requestId: ctx.requestId, kind: error.kind, reason: error.message },
        'storage: 拒绝的远程地址',
      );
      throw new DomainError(
        error.kind === 'refused' ? 'STORAGE_REMOTE_URL_REFUSED' : 'STORAGE_REMOTE_FETCH_FAILED',
      );
    }
    throw error;
  }

  const filename = filenameFromUrl(fetched.url);
  return storeFile(ctx, {
    file: { bytes: fetched.bytes, filename, declaredMime: fetched.contentType },
    maxBytes: settings.remoteImportMaxBytes,
    directory: 'attachment',
    categoryId,
    uploadedByAdminId: adminId,
    uploadedByUserId: null,
    name: body.name ?? filename,
  });
}

function filenameFromUrl(raw: string): string | undefined {
  try {
    const last = new URL(raw).pathname.split('/').pop() ?? '';
    const cleaned = decodeURIComponent(last).trim().slice(0, 255);
    return cleaned === '' ? undefined : cleaned;
  } catch {
    return undefined;
  }
}

/**
 * Storefront upload.
 *
 * Images only, a smaller ceiling, and a per-user hourly budget — the three
 * things that stop a review form from becoming free hosting. The shopper is
 * told the URL and nothing else about the library.
 */
export async function userUpload(
  ctx: Ctx,
  query: { purpose: UserUploadPurpose },
  file: FileSource,
): Promise<UserUploadResult> {
  const userId = requireUserId(ctx);
  const settings = await ctx.config.get(storageConfig);

  await enforce(
    fixedWindow(ctx.redis, {
      key: `storage:upload:user:${userId}`,
      limit: settings.userUploadsPerHour,
      windowMs: 60 * 60 * 1000,
      nowMs: ctx.clock.now().getTime(),
    }),
    'STORAGE_UPLOAD_RATE_LIMITED',
  );

  const result = await storeFile(ctx, {
    file: await readSource(file, settings.maxUserUploadBytes),
    maxBytes: settings.maxUserUploadBytes,
    directory: query.purpose,
    // A shopper's picture never lands in an admin's folder tree.
    categoryId: null,
    uploadedByAdminId: null,
    uploadedByUserId: userId,
    kinds: ['image'],
  });

  const { attachment } = result;
  return {
    url: attachment.url,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    width: attachment.width,
    height: attachment.height,
  };
}

/**
 * Whether `url` is exactly the URL of a live image in our own storage — what
 * `POST /api/v1/uploads` handed back, or any library image — or of one of its
 * thumbnails (`@shop/contracts/storage/image-variants`), which a client that
 * displayed the thumbnail may send back. For callers that must only accept a
 * picture we stored (the profile avatar, a review picture, after-sale
 * evidence), never one on somebody else's server.
 */
export async function isStoredImageUrl(ctx: Ctx, url: string): Promise<boolean> {
  if (url.length === 0 || url.length > 2048) return false;
  if (await repo.liveImageUrlExists(ctx.db, url)) return true;
  // A thumbnail (`….w480.jpg`) is ours exactly when its original is.
  const original = originalImageUrl(url);
  return original !== null && repo.liveImageUrlExists(ctx.db, original);
}

// ---------------------------------------------------------------------------
// scan-to-upload
// ---------------------------------------------------------------------------

/**
 * `url` is what the QR code encodes. A phone has no page to resolve a path
 * against, so it carries the deployment's own origin; with none stated it is a
 * bare path, and the admin page puts its own origin in front.
 */
export async function scanTokenCreate(ctx: Ctx, query: UploadQuery): Promise<ScanToken> {
  const adminId = requireAdminId(ctx);
  const settings = await ctx.config.get(storageConfig);
  const categoryId = query.categoryId === undefined ? null : fromId(query.categoryId);
  if (categoryId !== null) await requireCategory(ctx, categoryId);

  const store = createScanTokenStore(ctx.redis, () => ctx.clock.now());
  const { token, expiresAt } = await store.create({
    adminId,
    categoryId,
    directory: query.directory ?? null,
    ttlMs: settings.scanTokenTtlSeconds * 1000,
  });

  return {
    token,
    url: `${originFromEnv()}/scan-upload/${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function scanTokenStatusGet(
  ctx: Ctx,
  params: { token: string },
): Promise<ScanTokenStatus> {
  const adminId = requireAdminId(ctx);
  const store = createScanTokenStore(ctx.redis, () => ctx.clock.now());
  const record = await store.read(params.token);

  // A token minted by somebody else reads as expired: an admin has no business
  // learning that another admin's QR code exists.
  if (!record || record.adminId !== adminId) return { state: 'expired', attachment: null };
  if (record.state !== 'used') return { state: 'pending', attachment: null };

  const row =
    record.attachmentId === null
      ? undefined
      : await repo.findAttachment(ctx.db, record.attachmentId);
  return { state: 'used', attachment: row ? toItem(row) : null };
}

/**
 * 扫码上传 attempts per client address per hour. One phone uploading a shop's
 * worth of photos mints a fresh code per photo; sixty is more than anybody
 * does by hand and far less than a useful way to make the server parse bodies.
 */
export const SCAN_UPLOADS_PER_IP_PER_HOUR = 60;
/**
 * Attempts per code. A code is single-use, but a refused file puts it back —
 * so without this one code could be hammered for its whole life.
 */
export const SCAN_UPLOADS_PER_TOKEN = 10;

/**
 * The phone's upload.
 *
 * Public by contract — the phone that scanned the code has no session — so the
 * token *is* the authorisation, which is why it is claimed atomically and why
 * the resulting attachment is attributed to the admin who minted it rather than
 * to nobody. A claim that cannot be completed is released, so a picture the
 * sniffer refuses does not burn the QR code.
 *
 * It is also an unauthenticated multipart endpoint, so the work it does for a
 * stranger is bounded **before the body is read**: `file` may be a reader,
 * called only once the per-address and per-code budgets are spent and the code
 * is seen to be pending. `ip` is `clientIp()` — the edge's address.
 */
export async function scanUpload(
  ctx: Ctx,
  params: { token: string },
  file: FileSource,
  meta: { ip?: string | null } = {},
): Promise<UploadResult> {
  const nowMs = ctx.clock.now().getTime();
  await enforce(
    fixedWindow(ctx.redis, {
      // No edge address (a direct call, a test) shares one bucket rather than
      // being exempt from it.
      key: `storage:scan-upload:ip:${meta.ip ?? 'unknown'}`,
      limit: SCAN_UPLOADS_PER_IP_PER_HOUR,
      windowMs: 60 * 60 * 1000,
      nowMs,
    }),
    'STORAGE_UPLOAD_RATE_LIMITED',
  );
  await enforce(
    fixedWindow(ctx.redis, {
      key: `storage:scan-upload:token:${params.token}`,
      limit: SCAN_UPLOADS_PER_TOKEN,
      windowMs: 60 * 60 * 1000,
      nowMs,
    }),
    'STORAGE_UPLOAD_RATE_LIMITED',
  );

  const store = createScanTokenStore(ctx.redis, () => ctx.clock.now());
  // A cheap look first, so a spent or made-up code costs no body parse. The
  // atomic claim below is still what decides.
  const seen = await store.read(params.token);
  if (!seen || seen.state !== 'pending') throw new DomainError('STORAGE_SCAN_TOKEN_INVALID');
  const settings = await ctx.config.get(storageConfig);
  const incoming = await readSource(file, settings.maxUploadBytes);
  const claimed = await store.claim(params.token);
  if (!claimed) throw new DomainError('STORAGE_SCAN_TOKEN_INVALID');

  try {
    const result = await storeFile(ctx, {
      file: incoming,
      maxBytes: settings.maxUploadBytes,
      directory: claimed.directory ?? 'attachment',
      categoryId: claimed.categoryId,
      uploadedByAdminId: claimed.adminId,
      uploadedByUserId: null,
    });
    await store.complete(params.token, fromId(result.attachment.id));
    return result;
  } catch (error) {
    await store.release(params.token);
    throw error;
  }
}
