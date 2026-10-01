import { paymentAdminExceptionRefund } from '@shop/contracts/payment/payment.admin.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/payment-exceptions/:id/refund` — 原路退回.
 *
 * The same function the automatic effect calls, so the manual path and the
 * automatic one cannot drift. Pressing it twice queries the frozen refund
 * number instead of sending a second refund.
 */
export const POST = handle(paymentAdminExceptionRefund, async (ctx, { params, body }) => {
  const updated = await payment.adminRefundException(ctx, {
    id: params.id,
    ...(body.note === undefined ? {} : { note: body.note }),
  });
  ctx.audit(`payment-exception:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
