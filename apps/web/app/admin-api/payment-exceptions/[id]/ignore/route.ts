import { paymentAdminExceptionIgnore } from '@shop/contracts/payment/payment.admin.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/payment-exceptions/:id/ignore` — "we keep this money, and here is
 * why". The note is required: an ignored exception is a decision somebody has
 * to be able to defend later.
 */
export const POST = handle(paymentAdminExceptionIgnore, async (ctx, { params, body }) => {
  const updated = await payment.adminIgnoreException(ctx, { ...body, id: params.id });
  ctx.audit(`payment-exception:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
