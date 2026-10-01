import { IMAGE_VARIANT_WIDTHS, imageVariantKey } from '@shop/contracts/storage/image-variants';
import type { Ctx } from '../kernel/context';
import type { Storage } from '../kernel/storage';
import * as repo from './storage.repo';
import { resolveStorage } from './storage.service';
import { storageConfig } from './storage.config';

/**
 * Sweeping the bytes of deleted attachments.
 *
 * Deleting from the library tombstones the row and leaves the object alone,
 * because a product description written years ago may still point at the URL.
 * This job is the second half: once a tombstone is older than
 * `storage.orphanRetentionDays`, the object is removed and the row is purged.
 *
 * It never deletes **by directory listing** — walking an uploads folder and
 * removing anything older than a day, whether or not a record points at it,
 * loses pictures that are still in use. The database is the only authority:
 * nothing is deleted that does not have a tombstoned row, and
 * `listSweepableAttachments` refuses to touch a key any live row still uses
 * (two uploads of identical bytes share one object).
 *
 * Nor does it trust the library's delete button to mean "unused". A tombstone
 * whose key still appears in the shop's content — a logo, an avatar, a page, a
 * description, an order line's snapshot, or a thumbnail of any of them — keeps
 * its bytes and goes to the back of the queue, to be asked about again a
 * retention later (`repo.referencedNeedles`).
 *
 * `orphanRetentionDays: 0` disables it, which is the setting for a shop that
 * would rather pay for storage than ever lose a picture.
 */
export interface SweepReport {
  examined: number;
  removed: number;
  /** Still shown somewhere, so deferred. */
  kept: number;
  failed: number;
}

export async function cleanOrphanAttachments(
  ctx: Ctx,
  options: { limit?: number } = {},
): Promise<SweepReport> {
  const settings = await ctx.config.get(storageConfig);
  if (settings.orphanRetentionDays <= 0) return { examined: 0, removed: 0, kept: 0, failed: 0 };

  const limit = options.limit ?? 200;
  const before = new Date(
    ctx.clock.now().getTime() - settings.orphanRetentionDays * 24 * 60 * 60 * 1000,
  );

  const candidates = await repo.listSweepableAttachments(ctx.db, before, limit);
  if (candidates.length === 0) return { examined: 0, removed: 0, kept: 0, failed: 0 };

  const referenced = await repo.referencedNeedles(ctx.db, candidates.map(needleOf));
  const kept = candidates.filter((candidate) => referenced.has(needleOf(candidate)));
  await repo.deferAttachments(
    ctx.db,
    kept.map((candidate) => candidate.id),
    ctx.clock.now(),
  );

  const resolved = await resolveStorage(ctx);
  const purgeable: number[] = [];
  let failed = 0;

  for (const candidate of candidates) {
    if (referenced.has(needleOf(candidate))) continue;
    // A row written under a driver the shop no longer uses is left alone: its
    // bytes are in a bucket this process cannot address, and guessing would
    // delete the wrong object.
    if (candidate.driver !== resolved.driver) continue;
    try {
      await resolved.storage.delete(candidate.storageKey);
      await deleteVariants(ctx, resolved.storage, candidate.storageKey);
      purgeable.push(candidate.id);
    } catch (error) {
      // A driver that is briefly unavailable must not lose the record of what
      // still needs deleting, so the row stays and the next run retries it.
      failed += 1;
      ctx.logger.warn(
        { requestId: ctx.requestId, attachmentId: candidate.id, err: error },
        'storage: 清理孤儿素材失败，保留记录待下次重试',
      );
    }
  }

  const removed = await repo.purgeAttachments(ctx.db, purgeable);
  return { examined: candidates.length, removed, kept: kept.length, failed };
}

/**
 * What a reference to the object contains: the key without its extension, so
 * that a URL on any base (`/uploads/…`, a bucket, a CDN) and a thumbnail
 * (`….w480.jpg`) both contain it.
 */
function needleOf(candidate: repo.OrphanRow): string {
  return candidate.storageKey.replace(/\.[A-Za-z0-9]+$/, '');
}

/**
 * The thumbnails go with their original. Best effort: a leftover thumbnail is
 * a few kilobytes nobody links to, not a reason to keep the row (and so retry
 * the original's delete) forever.
 */
async function deleteVariants(ctx: Ctx, storage: Storage, key: string): Promise<void> {
  for (const width of IMAGE_VARIANT_WIDTHS) {
    const variant = imageVariantKey(key, width);
    if (!variant) return;
    await storage.delete(variant).catch((error: unknown) => {
      ctx.logger.warn({ requestId: ctx.requestId, err: error }, 'storage: 删除缩略图失败，已忽略');
    });
  }
}
