import { z } from 'zod';
import { foldProductViews } from '@shop/core/catalog';
import { defineJob } from '../define-job';

/**
 * Folds new `product_events` views into `products.views`.
 *
 * Every minute, staggered off the minute. The detail page no longer bumps the
 * counter on the product row, so this is what keeps the admin list's 浏览量
 * and the product card's count moving; they trail real views by about a
 * minute, which nobody reads a vanity counter closely enough to notice. The
 * run is bounded (`maxBatches` × `batchSize` events) and the next one carries
 * on from the watermark.
 */
export default defineJob({
  name: 'catalog.foldProductViews',
  schema: z
    .object({
      batchSize: z.number().int().min(1).max(200_000).default(50_000),
      maxBatches: z.number().int().min(1).max(100).default(20),
    })
    .prefault({}),
  concurrency: 1,
  repeat: { every: 60_000 },
  handler: async (ctx, payload) => {
    const report = await foldProductViews(ctx, payload);
    if (report.views > 0 || report.initialised) {
      ctx.logger.info(report, 'product views folded');
    }
  },
});
