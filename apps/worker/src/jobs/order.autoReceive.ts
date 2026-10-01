import { z } from 'zod';
import { autoReceive } from '@shop/core/order';
import { defineJob } from '../define-job';

/**
 * Confirms receipt for a buyer who never pressed the button.
 *
 * Enqueued by `shipOrder` (and by the virtual-delivery handler) the moment an
 * order becomes fully shipped, with a delay of `order-fulfil.autoReceiveDays`
 * and a `dedupeKey`, so two dispatches finishing the same order cannot queue
 * two of them.
 *
 * The buyer confirming first, or a refund taking the order out of `shipped`,
 * simply makes this a no-op: `receiveOrder` runs one conditional
 * `shipped -> received` and reports `received: false` when it loses. Losing is
 * the system working, not an error — which is why the sweep can run the same
 * code without a second thought.
 */
export default defineJob({
  name: 'order.autoReceive',
  schema: z.object({ orderId: z.string().regex(/^[1-9]\d*$/) }),
  concurrency: 4,
  handler: async (ctx, payload) => {
    const orderId = Number(payload.orderId);
    const outcome = await autoReceive(ctx, { orderId });
    if (outcome.received) ctx.logger.info({ orderId }, 'order auto-received');
  },
});
