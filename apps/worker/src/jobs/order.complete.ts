import { z } from 'zod';
import { completeOrder } from '@shop/core/order';
import { defineJob } from '../define-job';

/**
 * `received -> completed`, once the review window has run out.
 *
 * Enqueued by `receiveOrder` with a delay of `order-fulfil.reviewWindowDays`.
 * The handler re-reads `received_at` under the order lock and compares it with
 * the window as configured *now*, so shortening the window in the admin does
 * not leave a queue of jobs that fire too late — the sweep picks those up.
 */
export default defineJob({
  name: 'order.complete',
  schema: z.object({ orderId: z.string().regex(/^[1-9]\d*$/) }),
  concurrency: 4,
  handler: async (ctx, payload) => {
    const orderId = Number(payload.orderId);
    const outcome = await completeOrder(ctx, { orderId });
    if (outcome.completed) ctx.logger.info({ orderId }, 'order completed');
  },
});
