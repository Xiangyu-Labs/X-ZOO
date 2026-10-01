import { z } from 'zod';
import { remindUnpaid } from '@shop/core/order';
import { defineJob } from '../define-job';

/**
 * Sends one order's 未付款提醒, `unpaidReminderMinutes` before its payment
 * window closes.
 *
 * Enqueued by `order.create` with a `dedupeKey`, and withdrawn when the order
 * is cancelled. The shopper paying first makes this a no-op: the service
 * re-reads the order and only reminds about one still awaiting payment.
 *
 * Best effort: there is no sweep behind it, so a job the queue loses is one
 * reminder not sent, never an order left in the wrong state.
 */
export default defineJob({
  name: 'order.remindUnpaid',
  schema: z.object({ orderId: z.string().regex(/^[1-9]\d*$/) }),
  concurrency: 4,
  handler: async (ctx, payload) => {
    const orderId = Number(payload.orderId);
    const outcome = await remindUnpaid(ctx, { orderId });
    if (outcome.sent) ctx.logger.info({ orderId }, 'unpaid reminder recorded');
  },
});
