import { paymentAdminCapitalFlowSummary } from '@shop/contracts/payment/payment.admin.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/capital-flows/summary` — the numbers above the table.
 *
 * Over the whole filter rather than the page, which is why this query has no
 * `page`: a total that only covers twenty rows is a total nobody can use.
 */
export const GET = handle(paymentAdminCapitalFlowSummary, (ctx, { query }) =>
  payment.adminFlowSummary(ctx, query),
);

export const dynamic = 'force-dynamic';
