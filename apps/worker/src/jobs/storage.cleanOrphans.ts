import { z } from 'zod';
import { cleanOrphanAttachments } from '@shop/core/storage';
import { defineJob } from '../define-job';

/**
 * Removes the bytes of attachments that were deleted long enough ago.
 *
 * Deleting from the media library tombstones the row and leaves the object
 * alone, because a product description written years ago may still point at the
 * URL. This is the second half, and it runs nightly at 03:40 — staggered away
 * from `system.pruneSessions` (03:20) and `system.pruneAuditLogs` (03:50) so
 * three housekeeping jobs do not hit the database in the same minute.
 *
 * It replaces the old `clearPoster`, which deleted **by directory listing**: it
 * walked `public/uploads/routine/` and removed anything older than a day
 * whether or not a record pointed at it. Here the database is the only
 * authority — a tombstone whose URL the shop's content still shows is kept and
 * asked about again later — and `storage.orphanRetentionDays: 0` turns the job
 * off entirely.
 */
export default defineJob({
  name: 'storage.cleanOrphans',
  schema: z.object({ limit: z.number().int().min(1).max(1000).default(200) }).prefault({}),
  concurrency: 1,
  repeat: { pattern: '40 3 * * *' },
  handler: async (ctx, payload) => {
    const report = await cleanOrphanAttachments(ctx, { limit: payload.limit });
    if (report.removed > 0 || report.kept > 0 || report.failed > 0) {
      ctx.logger.info(report, 'swept deleted attachments');
    }
  },
});
