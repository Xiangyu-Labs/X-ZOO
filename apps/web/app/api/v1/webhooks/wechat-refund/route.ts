import { paymentWechatRefundNotify } from '@shop/contracts/payment/payment.webhook.contract';
import * as payment from '@shop/core/payment';
import * as refund from '@shop/core/refund';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/webhooks/wechat-refund` — 退款结果通知.
 *
 * Handled by the refund domain, which is the one that knows about `refunds`
 * rows; a notification whose merchant refund number is not one of those is
 * passed on to payment, whose exception refunds carry their own `X` numbers.
 * Same raw-body and same ack rules as the payment webhook.
 */
export const POST = handle(paymentWechatRefundNotify, async (ctx) =>
  payment.ackOrThrow(
    await refund.handleRefundNotify(ctx, {
      headers: Object.fromEntries(ctx.request.headers),
      rawBody: await ctx.request.text(),
    }),
  ),
);

export const dynamic = 'force-dynamic';
