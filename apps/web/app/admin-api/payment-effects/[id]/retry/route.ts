import { paymentAdminEffectRetry } from '@shop/contracts/payment/payment.admin.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/payment-effects/:id/retry` — un-parks one effect.
 *
 * Re-queues it; it does not run the handler. A parked effect is parked because
 * it kept failing, and its handler talks to WeChat — an admin request is the
 * wrong place to wait for that.
 */
export const POST = handle(paymentAdminEffectRetry, async (ctx, { params }) => {
  const result = await payment.adminRetryEffect(ctx, params);
  ctx.audit(`effect:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
