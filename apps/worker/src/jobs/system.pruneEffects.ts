import { z } from 'zod';
import { pruneEffects } from '@shop/core/effects';
import { defineJob } from '../define-job';

/**
 * Trims delivered side effects to their retention window. Nightly at 04:10.
 *
 * Every paid order, refund, shipment and notification leaves `effects` rows,
 * and nothing removed them. Only `done` rows go — a parked row is work for a
 * person and stays until somebody retries it — and `shipment` rows are kept
 * for good (`EFFECT_SCOPES_KEPT`). Bounded batches, like the audit log's.
 */
export default defineJob({
  name: 'system.pruneEffects',
  schema: z
    .object({
      retentionDays: z.number().int().min(30).max(3650).default(90),
      limit: z.number().int().min(100).max(100_000).default(5000),
    })
    .prefault({}),
  concurrency: 1,
  repeat: { pattern: '10 4 * * *' },
  handler: async (ctx, payload) => {
    const removed = await pruneEffects(ctx, payload);
    if (removed > 0) ctx.logger.info({ removed }, 'pruned delivered effects');
  },
});
