import { paymentStart } from '@shop/contracts/payment/payment.storefront.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/orders/:id/payments` — 去支付.
 *
 * A sub-resource POST, because starting a payment *creates* something: a
 * `payment_attempts` row with its own merchant order number. Tapping twice
 * returns the same attempt rather than minting a second one, and an order that
 * is already paid answers `alreadyPaid` instead of a new intent (CLIENT-001).
 *
 * `:id` is the order's surrogate id or its 24-digit number.
 */
export const POST = handle(paymentStart, (ctx, { params, body }) =>
  payment.start(ctx, params, body),
);

export const dynamic = 'force-dynamic';
