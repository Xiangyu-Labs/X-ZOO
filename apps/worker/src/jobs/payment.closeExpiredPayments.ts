import { z } from 'zod';
import { closeExpiredPayments } from '@shop/core/payment';
import { defineJob } from '../define-job';

/**
 * Closes the gateway order of every payment whose window has passed.
 *
 * This is the money half of expiry and it does not cancel anything: cancelling
 * releases stock and coupons, and that is the order domain's. What this job does is make the
 * payment side *final*, by asking WeChat to close each open attempt and
 * believing only a confirmed answer.
 *
 * It runs at `:01` of every fifth minute, two minutes ahead of
 * `order.sweepExpiredOrders` at `:03`. The gap is not load-bearing:
 * `cancelOrder` calls `closeOrderPayments` itself. The job still earns its
 * place — it makes the payment side final on its own for orders nobody is
 * trying to cancel, and it means the sweep two minutes later usually finds the
 * attempts already closed and makes no gateway call at all.
 */
export default defineJob({
  name: 'payment.closeExpiredPayments',
  schema: z.object({}).default({}),
  concurrency: 1,
  repeat: { pattern: '1/5 * * * *' },
  handler: async (ctx) => {
    const report = await closeExpiredPayments(ctx);
    if (report.examined > 0) ctx.logger.info(report, 'closed expired payment attempts');
  },
});
