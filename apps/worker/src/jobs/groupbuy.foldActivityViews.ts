import { z } from 'zod';
import { foldActivityViews } from '@shop/core/groupbuy';
import { defineJob } from '../define-job';

/**
 * Folds buffered `groupbuy:views:pending` increments into `groupbuy_activities.views`.
 *
 * Every minute, matching `catalog.foldProductViews`: keeps activity detail views
 * lock-free on the storefront request path.
 */
export default defineJob({
  name: 'groupbuy.foldActivityViews',
  schema: z.object({}).prefault({}),
  concurrency: 1,
  repeat: { every: 60_000 },
  handler: async (ctx) => {
    const report = await foldActivityViews(ctx);
    if (report.views > 0) {
      ctx.logger.info(report, 'groupbuy activity views folded');
    }
  },
});
