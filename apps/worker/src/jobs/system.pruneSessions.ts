import { z } from 'zod';
import { UserSessionService } from '@shop/core/auth';
import { defineJob } from '../define-job';
import { drainInBatches } from '../drain';

/**
 * Housekeeping: an expired `user_sessions` row can never be presented again,
 * so it is dead weight on the index. Nightly at 03:20.
 */
export default defineJob({
  name: 'system.pruneSessions',
  schema: z.object({ limit: z.number().int().min(100).max(100_000).default(5000) }).prefault({}),
  concurrency: 1,
  repeat: { pattern: '20 3 * * *' },
  handler: async (ctx, payload) => {
    const sessions = new UserSessionService();
    const removed = await drainInBatches(
      () => sessions.pruneExpired(ctx, { limit: payload.limit }),
      payload,
    );
    if (removed > 0) ctx.logger.info({ removed }, 'pruned expired storefront sessions');
  },
});
