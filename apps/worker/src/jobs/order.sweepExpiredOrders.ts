import { z } from 'zod';
import { sweepExpiredOrders } from '@shop/core/order';
import { defineJob } from '../define-job';

/**
 * The backstop for `order.autoCancel`: every five minutes, cancel any order
 * that is still `pending_payment` after its window closed.
 *
 * It exists because a queue can lose a delayed job and an order must not sit
 * on real stock forever. It reads the partial index
 * `orders_pay_expires_idx (pay_expires_at) WHERE status = 'pending_payment'`,
 * so an empty pass costs one index scan.
 *
 * Staggered off the hour (`:03`) so it does not start in the same second as
 * the other sweeps.
 *
 * `skipped` counts the orders whose payment the gateway would not confirm
 * closed. They are not failures of this pass — they release nothing and come
 * back on the next one — but a `skipped` that stays high across passes means
 * WeChat, or our credentials, and it wants a human.
 */
export default defineJob({
  name: 'order.sweepExpiredOrders',
  schema: z.object({}).default({}),
  concurrency: 1,
  repeat: { pattern: '3/5 * * * *' },
  handler: async (ctx) => {
    const { scanned, cancelled, skipped } = await sweepExpiredOrders(ctx);
    if (scanned > 0)
      ctx.logger.info({ scanned, cancelled, skipped }, 'swept expired unpaid orders');
  },
});
