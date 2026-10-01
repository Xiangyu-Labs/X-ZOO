import { paymentStatus } from '@shop/contracts/payment/payment.storefront.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/payments/:outTradeNo` — what the client polls after 拉起支付.
 *
 * Answers from the database only. A poll loop must never be able to make the
 * shop call WeChat, or a stuck client becomes a rate-limit incident. The
 * gateway is asked by the reconciliation
 * sweep, on its own schedule.
 */
export const GET = handle(paymentStatus, (ctx, { params }) =>
  payment.paymentStatus(ctx, params.outTradeNo),
);

export const dynamic = 'force-dynamic';
