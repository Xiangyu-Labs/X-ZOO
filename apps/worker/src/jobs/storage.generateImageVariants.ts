import { z } from 'zod';
import { GENERATE_IMAGE_VARIANTS_JOB, generateImageVariants } from '@shop/core/storage';
import { defineJob } from '../define-job';

/**
 * Writes the 480 / 960 px thumbnails of one uploaded picture.
 *
 * Enqueued by every new image upload once its transaction has committed
 * (`storage.service.ts`). It runs here rather than in the request because
 * decoding a phone photo takes real memory and CPU, and the web process serves
 * the admin on the same small host.
 *
 * One at a time: sharp holds a decoded picture while it works, and the worker
 * container is capped at 320 MB. A picture it cannot read is logged and left
 * with no thumbnail (the client falls back to the original); only a storage
 * failure throws, so the retry covers a bucket that was briefly unreachable.
 */
export default defineJob({
  name: GENERATE_IMAGE_VARIANTS_JOB,
  schema: z.object({
    attachmentId: z.string().regex(/^[1-9]\d*$/),
    /** Rewrite thumbnails that already exist (after a change of widths or quality). */
    force: z.boolean().default(false),
  }),
  concurrency: 1,
  attempts: 3,
  handler: async (ctx, payload) => {
    const report = await generateImageVariants(ctx, payload);
    if (report.written.length > 0) ctx.logger.debug(report, 'wrote image variants');
  },
});
