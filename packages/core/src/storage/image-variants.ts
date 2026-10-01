import {
  IMAGE_VARIANT_WIDTHS,
  hasImageVariants,
  imageVariantKey,
  type ImageVariantWidth,
} from '@shop/contracts/storage/image-variants';
import type SharpFactory from 'sharp';
import type { Ctx } from '../kernel/context';
import { fromId, toId } from '../kernel/ids';
import type { Storage } from '../kernel/storage';
import * as repo from './storage.repo';
import { resolveStorage } from './storage.service';

/**
 * Image variants: a 480 px and a 960 px wide copy of every uploaded JPEG, PNG
 * and WebP, stored next to the original under a name the client can derive
 * (`@shop/contracts/storage/image-variants`), so a product card downloads a few
 * dozen kilobytes instead of the merchant's 3 MB photo.
 *
 * **Fail soft, everywhere.** The original is stored and recorded before any of
 * this runs, and nothing here can undo that: a picture sharp cannot read, a
 * driver that refuses the write, a missing native binary — each is logged and
 * the upload stays as it was. The client falls back to the original when a
 * variant does not load.
 *
 * **Where it runs.** In the worker, as the `storage.generateImageVariants` job
 * the upload enqueues after its transaction commits. The web process only
 * enqueues: decoding a 12-megapixel photo inside a request handler would hold
 * the request, and the memory, of a 2-core host that also serves the admin.
 *
 * **What is written, per width:**
 *
 *  - the picture resized to that width (aspect kept, never enlarged), turned
 *    upright by its EXIF orientation, metadata stripped, re-encoded in its own
 *    format — so the URL keeps its extension and the client needs no lookup;
 *  - or **the original bytes unchanged**, when resizing would not make it
 *    smaller: a picture already narrower than the width, an animated WebP or
 *    PNG (resizing keeps only the first frame), or an encode that came out
 *    bigger. The variant URL then always resolves, and never looks worse.
 *
 * Nothing is written for a picture above `MAX_INPUT_PIXELS`: decoding it is
 * the one thing here that could exhaust the worker's memory, and the client
 * then simply keeps the original.
 */

/** 8000 × 5000. A larger picture is not decoded at all (see above). */
export const MAX_INPUT_PIXELS = 40_000_000;
/** One picture's budget; libvips stops and the variant is skipped. */
export const RENDER_TIMEOUT_SECONDS = 20;

export type VariantFormat = 'jpeg' | 'png' | 'webp';

export interface RenderedVariant {
  width: ImageVariantWidth;
  body: Uint8Array;
  /** The original's bytes, because resizing would not have made it smaller. */
  copied: boolean;
}

export type RenderOutcome =
  | { ok: true; variants: RenderedVariant[] }
  | { ok: false; reason: 'unsupported' | 'too-large' | 'unavailable' | 'failed'; error?: unknown };

type Sharp = typeof SharpFactory;
let sharpModule: Promise<Sharp | null> | null = null;

/**
 * sharp, loaded on first use and configured for a small box: no operation
 * cache (it would keep decoded pictures around between jobs) and one libvips
 * thread per picture. `null` when the native binary cannot be loaded, which
 * turns every render into a logged no-op instead of a crash.
 */
async function loadSharp(): Promise<Sharp | null> {
  sharpModule ??= import('sharp')
    .then((module) => {
      const sharp =
        (module as unknown as { default?: Sharp }).default ?? (module as unknown as Sharp);
      sharp.cache(false);
      sharp.concurrency(1);
      return sharp;
    })
    .catch(() => null);
  return sharpModule;
}

function formatOf(mime: string): VariantFormat | null {
  switch (mime) {
    case 'image/jpeg':
      return 'jpeg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return null;
  }
}

/**
 * An APNG carries an `acTL` chunk before its first `IDAT`. libvips reads only
 * the first frame, so resizing one would silently stop the animation.
 */
export function isAnimatedPng(bytes: Uint8Array): boolean {
  let offset = 8;
  while (offset + 8 <= bytes.byteLength) {
    const length =
      ((bytes[offset]! << 24) >>> 0) +
      (bytes[offset + 1]! << 16) +
      (bytes[offset + 2]! << 8) +
      bytes[offset + 3]!;
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

/**
 * The variants of one picture. Pure apart from sharp: no storage, no database,
 * so the unit test can feed it generated pictures.
 */
export async function renderImageVariants(
  bytes: Uint8Array,
  mime: string,
  options: { maxInputPixels?: number; loadSharp?: () => Promise<Sharp | null> } = {},
): Promise<RenderOutcome> {
  const format = formatOf(mime);
  if (!format) return { ok: false, reason: 'unsupported' };
  const sharp = await (options.loadSharp ?? loadSharp)();
  if (!sharp) return { ok: false, reason: 'unavailable' };

  const maxInputPixels = options.maxInputPixels ?? MAX_INPUT_PIXELS;
  // `failOn: 'error'`: a slightly damaged JPEG that every phone still shows
  // gets a thumbnail too; a truncated one does not.
  const input = { failOn: 'error' as const, limitInputPixels: maxInputPixels };
  try {
    const meta = await sharp(bytes, input).metadata();
    if (meta.width * meta.height > maxInputPixels) return { ok: false, reason: 'too-large' };

    const animated = (meta.pages ?? 1) > 1 || (format === 'png' && isAnimatedPng(bytes));
    const upright = meta.orientation === undefined || meta.orientation === 1;
    const displayWidth = meta.autoOrient.width;
    const original = Uint8Array.from(bytes);

    const variants: RenderedVariant[] = [];
    for (const width of IMAGE_VARIANT_WIDTHS) {
      if (animated || (upright && displayWidth <= width)) {
        variants.push({ width, body: original, copied: true });
        continue;
      }
      const pipeline = sharp(bytes, input)
        .timeout({ seconds: RENDER_TIMEOUT_SECONDS })
        .autoOrient()
        .resize({ width, withoutEnlargement: true });
      const encoded =
        format === 'jpeg'
          ? pipeline.jpeg({ quality: 80, progressive: true })
          : format === 'png'
            ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
            : pipeline.webp({ quality: 80 });
      const body = new Uint8Array(await encoded.toBuffer());
      variants.push(
        body.byteLength < bytes.byteLength
          ? { width, body, copied: false }
          : { width, body: original, copied: true },
      );
    }
    return { ok: true, variants };
  } catch (error) {
    return { ok: false, reason: 'failed', error };
  }
}

export interface VariantReport {
  attachmentId: string;
  /** Widths written by this call. */
  written: ImageVariantWidth[];
  /** Why nothing (more) was written, when that is the case. */
  skipped?: 'not-found' | 'no-variants' | 'other-driver' | 'present' | RenderFailure;
}

type RenderFailure = Exclude<RenderOutcome, { ok: true }>['reason'];

async function missingWidths(storage: Storage, key: string): Promise<ImageVariantWidth[]> {
  const missing: ImageVariantWidth[] = [];
  for (const width of IMAGE_VARIANT_WIDTHS) {
    const variant = imageVariantKey(key, width);
    if (variant && !(await storage.exists(variant))) missing.push(width);
  }
  return missing;
}

/**
 * Writes the missing variants of one attachment. Idempotent: widths already
 * present are left alone (`force` rewrites them), so a retried job, a second
 * enqueue and the backfill can all run over the same picture.
 *
 * Never throws for a picture it cannot handle; it reports and returns. It
 * throws only when the storage driver fails, so the job's retry covers a
 * bucket that was briefly unreachable.
 */
export async function generateImageVariants(
  ctx: Ctx,
  input: { attachmentId: string; force?: boolean | undefined },
): Promise<VariantReport> {
  const attachmentId = input.attachmentId;
  const row = await repo.findAttachment(ctx.db, fromId(attachmentId));
  if (!row || row.kind !== 'image') return { attachmentId, written: [], skipped: 'not-found' };
  if (!hasImageVariants(row.storageKey)) {
    return { attachmentId, written: [], skipped: 'no-variants' };
  }

  const resolved = await resolveStorage(ctx);
  // Bytes under a driver the shop no longer uses live where this process
  // cannot write next to them.
  if (row.driver !== resolved.driver) {
    return { attachmentId, written: [], skipped: 'other-driver' };
  }
  const storage = resolved.storage;
  const wanted = input.force
    ? [...IMAGE_VARIANT_WIDTHS]
    : await missingWidths(storage, row.storageKey);
  if (wanted.length === 0) return { attachmentId, written: [], skipped: 'present' };

  const bytes = await storage.get(row.storageKey);
  const outcome = await renderImageVariants(bytes, row.mime);
  if (!outcome.ok) {
    const log = outcome.reason === 'unsupported' ? ctx.logger.info : ctx.logger.warn;
    log.call(
      ctx.logger,
      { requestId: ctx.requestId, attachmentId, reason: outcome.reason, err: outcome.error },
      'storage: 未生成缩略图，列表将继续使用原图',
    );
    return { attachmentId, written: [], skipped: outcome.reason };
  }

  const written: ImageVariantWidth[] = [];
  for (const variant of outcome.variants) {
    if (!wanted.includes(variant.width)) continue;
    await storage.putVariant(row.storageKey, variant.width, variant.body, row.mime);
    written.push(variant.width);
  }
  return { attachmentId, written };
}

export interface BackfillBatch {
  examined: number;
  written: number;
  failed: number;
  /** Where the next batch starts; `null` when the library is done. */
  nextAfterId: string | null;
}

/**
 * One batch of the backfill: live images with an id above `afterId`, in id
 * order. The caller (the `storage.backfillImageVariants` job) enqueues the
 * next batch from `nextAfterId`, so a restart resumes where it stopped and the
 * worker is never busy with one job for long.
 *
 * A picture that fails is counted and passed over — the backfill must not
 * stall on one broken file.
 */
export async function backfillImageVariants(
  ctx: Ctx,
  input: { afterId?: string | undefined; limit: number; force?: boolean | undefined },
): Promise<BackfillBatch> {
  const afterId = input.afterId === undefined ? 0 : fromId(input.afterId);
  const ids = await repo.listImageAttachmentIds(ctx.db, afterId, input.limit);
  let written = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const report = await generateImageVariants(ctx, {
        attachmentId: toId(id),
        force: input.force,
      });
      if (report.written.length > 0) written += 1;
      if (report.skipped === 'failed') failed += 1;
    } catch (error) {
      failed += 1;
      ctx.logger.warn(
        { requestId: ctx.requestId, attachmentId: toId(id), err: error },
        'storage: 补生成缩略图失败，跳过',
      );
    }
  }
  const last = ids.at(-1);
  return {
    examined: ids.length,
    written,
    failed,
    nextAfterId: ids.length === input.limit && last !== undefined ? toId(last) : null,
  };
}
