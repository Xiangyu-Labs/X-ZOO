import { z } from 'zod';
import { UserSessionService } from '@shop/core/auth';
import { defineJob } from '../define-job';

/**
 * Housekeeping: an expired `user_sessions` row can never be presented again,
 * so it is dead weight on the index. Nightly at 03:20.
 */
export default defineJob({
  name: 'system.pruneSessions',
  schema: z.object({}).default({}),
  concurrency: 1,
  repeat: { pattern: '20 3 * * *' },
  handler: async (ctx) => {
    const removed = await new UserSessionService().pruneExpired(ctx);
    if (removed > 0) ctx.logger.info({ removed }, 'pruned expired storefront sessions');
  },
});
