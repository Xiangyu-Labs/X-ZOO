import { z } from 'zod';
import { autoCancel } from '@shop/core/order';
import { defineJob } from '../define-job';

/**
 * Cancels one order whose payment window has closed.
 *
 * Enqueued by `order.create` with a delay of the configured window and a
 * `dedupeKey`, so a retried submit cannot queue two of them. The shopper
 * paying, or cancelling themselves, simply makes this a no-op: the service
 * re-reads the window under the order's lock and the transition is conditional,
 * so losing the race is the system working rather than an error.
 *
 * Nothing depends on this job for correctness — `order.sweepExpiredOrders` is
 * the backstop if the queue loses it.
 */
export default defineJob({
  name: 'order.autoCancel',
  schema: z.object({ orderId: z.string().regex(/^[1-9]\d*$/) }),
  concurrency: 4,
  handler: async (ctx, payload) => {
    const orderId = Number(payload.orderId);
    const outcome = await autoCancel(ctx, { orderId });
    if (outcome.cancelled) ctx.logger.info({ orderId }, 'order auto-cancelled');
  },
});
