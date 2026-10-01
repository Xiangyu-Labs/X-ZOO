import { paymentAdminExceptionRecheck } from '@shop/contracts/payment/payment.admin.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../../../src/server';

/** `/admin-api/payment-exceptions/:id/recheck` — ask the gateway again, by the frozen number. */
export const POST = handle(paymentAdminExceptionRecheck, async (ctx, { params }) => {
  const updated = await payment.adminRecheckException(ctx, params);
  ctx.audit(`payment-exception:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
