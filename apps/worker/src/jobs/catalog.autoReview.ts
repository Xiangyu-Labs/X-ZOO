import { z } from 'zod';
import { runAutoReview } from '@shop/core/catalog';
import { defineJob } from '../define-job';

/**
 * 系统默认好评: after the configured number of days, a completed order line
 * nobody reviewed gets a five-star review with the configured text.
 *
 * Hourly, at :23 — staggered away from the other catalog sweep and from the
 * coupon jobs so a small deployment never runs two table scans in the same
 * minute.
 *
 * Safe to run twice and safe to miss: the uniqueness index on `order_item_id`
 * is what stops a second review, not a check this job has to get right, and a
 * line that came due yesterday is still due today. The shopper's own review
 * always wins, because the port only returns lines with no review at all.
 *
 * `limit` bounds one pass so a shop that has never run this drains over
 * several hours instead of holding one enormous transaction.
 */
export default defineJob({
  name: 'catalog.autoReview',
  schema: z.object({ limit: z.number().int().min(1).max(1000).default(200) }).prefault({}),
  concurrency: 1,
  repeat: { pattern: '23 * * * *' },
  handler: async (ctx, payload) => {
    const result = await runAutoReview(ctx, { limit: payload.limit });
    if (result.written > 0) {
      ctx.logger.info(result, 'wrote default reviews');
    }
  },
});
