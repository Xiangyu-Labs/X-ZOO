import { z } from 'zod';
import { closeEndedActivities } from '@shop/core/groupbuy';
import { defineJob } from '../define-job';

/**
 * Moves a 拼团 campaign to 已结束 once its 结束时间 has passed (RISK-D-014).
 *
 * Every minute, like presale's window sweep: the admin form states the end to the minute.
 * The storefront does not wait for it — its list and checkout already test the window — so
 * what this adds is the `ended` status the admin list shows and filters on. Bounded by
 * `groupbuy.groupExpirySweepLimit`; every close is conditional, so an overlapping run costs
 * nothing.
 */
export default defineJob({
  name: 'groupbuy.sweepEndedActivities',
  schema: z.object({}).prefault({}),
  concurrency: 1,
  repeat: { pattern: '* * * * *' },
  handler: async (ctx) => {
    const report = await closeEndedActivities(ctx);
    if (report.closed > 0) ctx.logger.info(report, 'groupbuy: closed ended activities');
  },
});
