import { z } from 'zod';
import { recheckExceptionRefunds } from '@shop/core/payment';
import { defineJob } from '../define-job';

/**
 * Chases the automatic refunds of payment exceptions whose result never came
 * back.
 *
 * A payment exception is money that arrived for an order that could not accept
 * it — a cancelled order, a closed attempt, an amount that does not match. The
 * system refunds it without asking anyone, because holding a stranger's money
 * is the one outcome with no acceptable explanation. When that refund's answer
 * is lost, this job asks again **by the frozen `out_refund_no`** and never
 * re-submits (REFUND-005): a re-send with a fresh number is how one exception
 * becomes two refunds.
 *
 * Every ten minutes is deliberate. Nobody is waiting on a screen for this, and
 * an exception that resolves on the sixth pass instead of the second costs
 * nothing, while ten minutes of WeChat queries per exception costs rate limit
 * that a live checkout may want.
 */
export default defineJob({
  name: 'payment.recheckExceptionRefunds',
  schema: z.object({}).default({}),
  concurrency: 1,
  repeat: { pattern: '4/10 * * * *' },
  handler: async (ctx) => {
    const report = await recheckExceptionRefunds(ctx);
    if (report.examined > 0) ctx.logger.info(report, 'rechecked exception refunds');
  },
});
