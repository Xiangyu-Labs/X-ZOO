import { paymentAdminAttemptList } from '@shop/contracts/payment/payment.admin.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../src/server';

/** `/admin-api/payment-attempts` — 支付记录. A report; nothing here moves money. */
export const GET = handle(paymentAdminAttemptList, (ctx, { query }) =>
  payment.adminListAttempts(ctx, query),
);

export const dynamic = 'force-dynamic';
