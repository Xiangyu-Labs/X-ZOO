import { z } from 'zod';
import { disableClosedCampaigns } from '@shop/core/coupon';
import { defineJob } from '../define-job';

/**
 * Disables campaigns whose claim window has closed, so the admin list stops
 * showing a finished campaign as 进行中. Every ten minutes.
 *
 * Also belt-and-braces: the storefront list filters on `claim_to` as well, so
 * a late run never makes a closed campaign claimable.
 */
export default defineJob({
  name: 'coupon.closeClaimWindows',
  schema: z.object({}).default({}),
  concurrency: 1,
  repeat: { pattern: '*/10 * * * *' },
  handler: async (ctx) => {
    const disabled = await disableClosedCampaigns(ctx);
    if (disabled > 0) ctx.logger.info({ disabled }, 'closed coupon campaigns');
  },
});
