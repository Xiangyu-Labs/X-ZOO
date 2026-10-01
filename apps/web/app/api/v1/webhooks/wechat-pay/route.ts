import { paymentWechatNotify } from '@shop/contracts/payment/payment.webhook.contract';
import * as payment from '@shop/core/payment';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/webhooks/wechat-pay` — 支付结果通知.
 *
 * The raw body is read here rather than declared as a schema: a v3 signature
 * covers the exact bytes, and a JSON round-trip would change them. The headers
 * go across as they arrived (lowercased by `Headers`, which is how the client
 * reads them).
 *
 * `ackOrThrow` turns a non-200 result into the registered error whose status it
 * is, because `handle()` takes the status from the contract. WeChat reads the
 * status and, on a 200, `code`; anything else means "deliver this again".
 */
export const POST = handle(paymentWechatNotify, async (ctx) =>
  payment.ackOrThrow(
    await payment.handleTransactionNotify(ctx, {
      headers: Object.fromEntries(ctx.request.headers),
      rawBody: await ctx.request.text(),
    }),
  ),
);

export const dynamic = 'force-dynamic';
