import { paymentAdminEffectList } from '@shop/contracts/payment/payment.admin.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../src/server';

/**
 * `/admin-api/payment-effects` — 需人工处理.
 *
 * The parked rows of the effects ledger, scoped to `paymentEffectScopes`
 * (everything but the notification send log).
 */
export const GET = handle(paymentAdminEffectList, (ctx, { query }) =>
  payment.adminListEffects(ctx, query),
);

export const dynamic = 'force-dynamic';
