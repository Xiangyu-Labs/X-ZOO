import { z } from 'zod';
import { pruneBrowseHistory } from '@shop/core/catalog';
import { defineJob } from '../define-job';

/**
 * Drops 足迹 rows older than the configured retention window.
 *
 * Daily at 03:41, which is both off-peak and staggered away from every other
 * repeatable job. Nothing depends on it for correctness — `historyList` filters
 * on the same window — so a missed run shows the shopper nothing extra; it
 * exists so `product_events` does not grow without end.
 *
 * Batched: a long-neglected shop drains over several nights rather than
 * holding one transaction over a million rows.
 */
export default defineJob({
  name: 'catalog.pruneHistory',
  schema: z.object({ limit: z.number().int().min(1).max(50_000).default(5000) }).prefault({}),
  concurrency: 1,
  repeat: { pattern: '41 3 * * *' },
  handler: async (ctx, payload) => {
    const { deleted } = await pruneBrowseHistory(ctx, { limit: payload.limit });
    if (deleted > 0) ctx.logger.info({ deleted }, 'pruned browse history');
  },
});
