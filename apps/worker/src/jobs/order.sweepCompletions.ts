import { z } from 'zod';
import { sweepCompletions } from '@shop/core/order';
import { defineJob } from '../define-job';

/**
 * The backstop for `order.complete`, hourly.
 *
 * It also covers the case the delayed job cannot: an operator shortening
 * `reviewWindowDays` after the jobs were queued. Those orders are already due
 * and this pass finishes them.
 */
export default defineJob({
  name: 'order.sweepCompletions',
  schema: z.object({}).default({}),
  concurrency: 1,
  repeat: { pattern: '11 * * * *' },
  handler: async (ctx) => {
    const { scanned, completed } = await sweepCompletions(ctx);
    if (scanned > 0) ctx.logger.info({ scanned, completed }, 'swept orders past the review window');
  },
});
