import { z } from 'zod';
import { pruneVisits } from '@shop/core/user';
import { defineJob } from '../define-job';

/**
 * Drops page views older than `stats.visitRetentionDays` (400 days unless an
 * operator changed it), so `user_visits` does not grow without end.
 *
 * Daily at 03:44: off-peak, and staggered away from the other nightly sweeps
 * (03:20 sessions, 03:40 orphaned uploads, 03:41 browse history, 03:50 audit
 * log). Nothing depends on it for correctness — a missed run only keeps old
 * rows a day longer.
 *
 * Batched: a table that was never swept drains over several nights rather than
 * holding one transaction over millions of rows.
 */
export default defineJob({
  name: 'user.pruneVisits',
  schema: z.object({ limit: z.number().int().min(1).max(50_000).default(20_000) }).prefault({}),
  concurrency: 1,
  repeat: { pattern: '44 3 * * *' },
  handler: async (ctx, payload) => {
    const { deleted } = await pruneVisits(ctx, { limit: payload.limit });
    if (deleted > 0) ctx.logger.info({ deleted }, 'pruned page views');
  },
});
