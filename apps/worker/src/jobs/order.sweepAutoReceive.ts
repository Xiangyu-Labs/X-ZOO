import { z } from 'zod';
import { sweepAutoReceive } from '@shop/core/order';
import { defineJob } from '../define-job';

/**
 * The backstop for `order.autoReceive`: every ten minutes, confirm receipt on
 * anything past its deadline.
 *
 * It reads the partial index
 * `orders_auto_receive_idx (auto_receive_at) WHERE status = 'shipped'`, so an
 * empty pass costs one index scan. Nothing depends on it for correctness —
 * both paths run the same conditional transition, so a double delivery is a
 * no-op.
 *
 * Staggered off the hour (`:07`) so it does not start in the same second as
 * `order.sweepExpiredOrders` or the completion sweep.
 */
export default defineJob({
  name: 'order.sweepAutoReceive',
  schema: z.object({}).default({}),
  concurrency: 1,
  repeat: { pattern: '7/10 * * * *' },
  handler: async (ctx) => {
    const { scanned, received } = await sweepAutoReceive(ctx);
    if (scanned > 0) ctx.logger.info({ scanned, received }, 'swept orders past auto-receive');
  },
});
