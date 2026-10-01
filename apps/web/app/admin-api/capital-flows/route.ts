import { paymentAdminCapitalFlowList } from '@shop/contracts/payment/payment.admin.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../src/server';

/** `/admin-api/capital-flows` — 资金流水, one row per booked payment or refund. */
export const GET = handle(paymentAdminCapitalFlowList, (ctx, { query }) =>
  payment.adminListFlows(ctx, query),
);

export const dynamic = 'force-dynamic';
