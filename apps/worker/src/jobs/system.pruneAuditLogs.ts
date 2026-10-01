import { z } from 'zod';
import { pruneAuditLogs } from '@shop/core/system';
import { defineJob } from '../define-job';

/**
 * Trims the audit log to its retention window. Nightly at 03:50.
 *
 * The table grows by one row per admin write forever, and nobody has ever
 * needed the 2019 rows. Deleted in bounded batches so one overdue run cannot
 * take a lock long enough to be noticed.
 */
export default defineJob({
  name: 'system.pruneAuditLogs',
  schema: z
    .object({
      retentionDays: z.number().int().min(30).max(3650).default(365),
      limit: z.number().int().min(100).max(100_000).default(5000),
    })
    .prefault({}),
  concurrency: 1,
  repeat: { pattern: '50 3 * * *' },
  handler: async (ctx, payload) => {
    const removed = await pruneAuditLogs(ctx, payload);
    if (removed > 0) ctx.logger.info({ removed }, 'pruned audit log rows');
  },
});
