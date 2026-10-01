import { z } from 'zod';
import { settleExpiredGroups } from '@shop/core/groupbuy';
import { defineJob } from '../define-job';

/**
 * The backstop for teams whose time ran out.
 *
 * A team settles on its own `groupbuy.expire` effect, recorded in the same
 * transaction that opened it, so the normal path is immediate. This sweep
 * exists for the abnormal one: an effect parked after eight failures, a restore
 * from a backup taken before the ledger was written, a deploy that stopped the
 * effects runner for an hour.
 *
 * Every six minutes past ten — staggered away from the order, payment and
 * refund sweeps so a small deployment never runs two table scans in the same
 * minute. It reads `groupbuy_groups_expiry_idx`, settles each team in its own
 * transaction, and is safe to run twice: `failGroup`, `virtuallyFillAndSucceed`
 * and `cancelEmptyGroup` all carry `status = 'forming'` in their `WHERE`, and
 * the refund request is a `UNIQUE (scope, scope_id, event_type)` effect.
 *
 * How many teams one pass handles is `groupbuy.groupExpirySweepLimit`, so an
 * operator can drain a backlog without holding one enormous transaction.
 */
export default defineJob({
  name: 'groupbuy.sweepExpiredGroups',
  schema: z.object({}).prefault({}),
  concurrency: 1,
  repeat: { pattern: '6/10 * * * *' },
  handler: async (ctx) => {
    const report = await settleExpiredGroups(ctx);
    if (report.scanned > 0) ctx.logger.info(report, 'groupbuy: swept expired teams');
  },
});
