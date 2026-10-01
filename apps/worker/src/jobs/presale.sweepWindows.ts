import { z } from 'zod';
import { sweepPresaleWindows } from '@shop/core/presale';
import { defineJob } from '../define-job';

/**
 * Opens and closes presale sale windows on time.
 *
 * Every minute, because a campaign's window is stated to the minute on the
 * admin form and an operator who sets 结束时间 to 18:00 expects the 预售 badge
 * gone at 18:00. The work is bounded by `presale.windowSweepLimit` and both
 * halves are conditional or exactly-once, so a minute that overlaps the
 * previous run costs nothing.
 *
 * The storefront does not wait for this job: its list already filters on
 * `start_at <= now < end_at`, so a campaign stops being buyable at the instant
 * its window closes whether or not the sweep has run. What the sweep adds is
 * the `ended` status the admin filters on and the two effects notifications
 * hang off.
 */
export default defineJob({
  name: 'presale.sweepWindows',
  schema: z.object({}).default({}),
  concurrency: 1,
  repeat: { pattern: '* * * * *' },
  handler: async (ctx) => {
    const report = await sweepPresaleWindows(ctx);
    if (report.closed > 0 || report.opened > 0) {
      ctx.logger.info({ ...report }, 'presale: swept activity windows');
    }
  },
});
