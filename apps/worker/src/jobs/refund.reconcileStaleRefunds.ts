import { z } from 'zod';
import { reconcileStaleRefunds } from '@shop/core/refund';
import { defineJob } from '../define-job';

/**
 * Resolves refunds whose result never arrived.
 *
 * The mirror of `payment.reconcileStalePayments`, and it matters more, because
 * a refund left in the dark has a buyer attached to it. A `processing` row is
 * one WeChat accepted and has not reported on; an `unknown` row is one where
 * our own submit call did not come back, so the money may or may not have
 * moved. Both are resolved the same way: query the frozen `out_refund_no`.
 *
 * Never by re-sending, and never by elapsed time (REFUND-006). A retry that
 * mints a new refund number is how a buyer gets refunded twice, and no amount
 * of waiting turns silence into an answer.
 *
 * Runs at `:04` of every fifth minute, off the two payment sweeps so the three
 * of them do not open gateway connections in the same second.
 */
export default defineJob({
  name: 'refund.reconcileStaleRefunds',
  schema: z.object({}).default({}),
  concurrency: 1,
  repeat: { pattern: '4/5 * * * *' },
  handler: async (ctx) => {
    const report = await reconcileStaleRefunds(ctx);
    if (report.examined > 0) ctx.logger.info(report, 'reconciled stale refunds');
  },
});
