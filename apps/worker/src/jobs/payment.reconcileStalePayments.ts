import { z } from 'zod';
import { reconcileStalePayments } from '@shop/core/payment';
import { defineJob } from '../define-job';

/**
 * Asks the gateway about every attempt that has sat in a non-final state.
 *
 * The one payment job that exists purely because *a notification can be
 * lost*. A deploy, a network blip or one 500 is enough, and WeChat gives up
 * retrying after a day — after which a shop that only learns about money from
 * callbacks has a paid order it thinks is unpaid, and a buyer whose goods never
 * ship. Nothing else in the system would ever notice.
 *
 * It re-derives the ledger by querying the frozen `out_trade_no`, never by
 * elapsed time, and it includes healthy-looking `submitted` rows rather than
 * only `unknown` ones, because a lost notification leaves no trace on the row
 * it belonged to.
 *
 * Safe to run beside a live callback for the same attempt: both settle through
 * the same conditional update, so the loser books nothing and logs a replay
 * (PAYC-002).
 */
export default defineJob({
  name: 'payment.reconcileStalePayments',
  schema: z.object({}).default({}),
  concurrency: 1,
  repeat: { pattern: '2/5 * * * *' },
  handler: async (ctx) => {
    const report = await reconcileStalePayments(ctx);
    if (report.examined > 0) ctx.logger.info(report, 'reconciled stale payment attempts');
  },
});
