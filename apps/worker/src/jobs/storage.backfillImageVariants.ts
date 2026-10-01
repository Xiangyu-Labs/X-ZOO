import { z } from 'zod';
import { backfillImageVariants } from '@shop/core/storage';
import { defineJob } from '../define-job';

export const BACKFILL_IMAGE_VARIANTS_JOB = 'storage.backfillImageVariants';

/**
 * Thumbnails for the pictures uploaded before thumbnails existed.
 *
 * **Never scheduled.** An operator starts it once after the release that
 * brings thumbnails (docs/mini/status/P2-images.md):
 *
 *     ./shop compose exec -T worker node /app/main.mjs enqueue storage.backfillImageVariants
 *
 * Each run handles one batch of live images in id order, then enqueues the
 * next batch from where it stopped — so the worker is never tied up for long,
 * other jobs interleave, and a redeploy mid-way resumes rather than restarts.
 * Pictures that already have both thumbnails cost one existence check each, so
 * running it twice is harmless. `force` rewrites existing thumbnails.
 */
export default defineJob({
  name: BACKFILL_IMAGE_VARIANTS_JOB,
  schema: z
    .object({
      afterId: z
        .string()
        .regex(/^[1-9]\d*$/)
        .optional(),
      limit: z.number().int().min(1).max(500).default(50),
      force: z.boolean().default(false),
    })
    .prefault({}),
  concurrency: 1,
  attempts: 3,
  handler: async (ctx, payload) => {
    const batch = await backfillImageVariants(ctx, payload);
    ctx.logger.info({ ...batch, afterId: payload.afterId ?? null }, 'image variant backfill batch');
    if (batch.nextAfterId === null) {
      ctx.logger.info('image variant backfill finished');
      return;
    }
    // The last step, so a job that gets here has nothing left to retry: the
    // chain cannot fork. No dedupe key either — a second run started within
    // the hour BullMQ keeps finished ids would otherwise stop at the first one.
    await ctx.queue.enqueue(BACKFILL_IMAGE_VARIANTS_JOB, {
      afterId: batch.nextAfterId,
      limit: payload.limit,
      force: payload.force,
    });
  },
});
