import { defineRoute } from '../_conventions/route';
import { webhookAck } from './schemas';

/**
 * The WeChat Pay v3 callbacks.
 *
 * ## Why neither route declares a `body`
 *
 * A v3 signature is computed over `timestamp\nnonce\n<raw body>\n` — the exact
 * bytes, before any JSON round-trip. `handle()` consumes the request stream to
 * parse a declared body, which would leave the handler with a re-serialised
 * string that no longer matches what was signed. So these two routes take no
 * body schema, and the route file reads `ctx.request.text()` itself and hands
 * the raw string plus the five `Wechatpay-*` headers to the service. The shape
 * that comes out of the envelope after verification is
 * `wechatNotifyEnvelope` in `schemas.ts`.
 *
 * ## The ack contract
 *
 * WeChat retries a notification until it is acknowledged with HTTP 200 and
 * `{"code":"SUCCESS"}`. The rules this domain follows, in order:
 *
 *  1. **Verify the signature before anything else** (TLS-005). An unverified
 *     notification is answered 401 `{"code":"FAIL"}` and nothing is written
 *     apart from an audit line — a forged "money received" is never believed.
 *  2. **Insert into `payment_callbacks` first.** `UNIQUE (mch_id,
 *     provider_notify_id)` turns a replay into a unique violation, which is
 *     answered SUCCESS without re-running any effect (PAY-007).
 *  3. **Persist before acking.** A notification we cannot book — cancelled
 *     order, unknown merchant order number, a second real payment — becomes a
 *     `payment_exceptions` row *and then* a SUCCESS (PAY-011). Acking first and
 *     logging afterwards loses money silently when the log write fails.
 *  4. **An internal failure answers FAIL** so the gateway retries (PAY-003).
 */

export const paymentWechatNotify = defineRoute({
  id: 'payment.wechatNotify',
  method: 'POST',
  path: '/api/v1/webhooks/wechat-pay',
  auth: 'webhook',
  summary: '微信支付结果通知',
  tags: ['payment', 'webhook'],
  response: webhookAck,
  examples: [
    {
      name: 'accepted',
      response: { code: 'SUCCESS', message: '成功' },
    },
    {
      name: 'replayed',
      // Same notify id as one already stored: acknowledged, nothing re-run.
      response: { code: 'SUCCESS', message: '重复通知，已忽略' },
    },
    {
      name: 'signature-rejected',
      response: { code: 'FAIL', message: '签名验证失败' },
    },
  ],
});

export const paymentWechatRefundNotify = defineRoute({
  id: 'payment.wechatRefundNotify',
  method: 'POST',
  path: '/api/v1/webhooks/wechat-refund',
  auth: 'webhook',
  summary: '微信退款结果通知',
  tags: ['payment', 'refund', 'webhook'],
  response: webhookAck,
  examples: [
    {
      name: 'refund-succeeded',
      response: { code: 'SUCCESS', message: '成功' },
    },
    {
      name: 'refund-abnormal',
      // REFUND.ABNORMAL: the money could not go back through the original
      // channel. Recorded, the refund is parked, and an operator is told.
      response: { code: 'SUCCESS', message: '已记录，待人工处理' },
    },
    {
      name: 'signature-rejected',
      response: { code: 'FAIL', message: '签名验证失败' },
    },
  ],
});
