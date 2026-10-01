import { z } from 'zod';
import { defineRoute } from '../_conventions/route';

/**
 * The Official Account message callback, `/api/v1/webhooks/wechat-oa`.
 *
 * ## These two routes do not go through `handle()`
 *
 * Everything else in the system speaks JSON. WeChat does not: the verification
 * handshake wants the bare `echostr` back as `text/plain`, and an event wants
 * either the five ASCII letters `success` or an XML reply document. `handle()`
 * always serialises to JSON, so the two route files build their `Response`
 * themselves and keep to one line of logic each — the parsing, the signature
 * check and the reply engine all live in `core/src/wechat-oa`.
 *
 * They are declared here anyway, because the OpenAPI document is what tells an
 * operator which URL to paste into 公众平台 → 服务器配置, and because the
 * storefront adapter must be able to see that this path is taken. `response` is
 * `z.string()`: the literal body bytes.
 *
 * ## The order of operations, which is the whole security story
 *
 *  1. **Signature first, before any parsing.** `sha1(sort(token, timestamp,
 *     nonce))` compared with `timestamp_signature`-style constant time. A body
 *     that fails this is never XML-parsed, never logged in full and never
 *     touches the database — so a forged "user 张三 unsubscribed" cannot even
 *     cost us a row. Answered `403` with the body `invalid signature`.
 *  2. **Decrypt if the account is in 安全模式/兼容模式.** AES-256-CBC with the
 *     43-character `EncodingAESKey`, and the appid inside the envelope is
 *     checked against ours — decrypting successfully is not the same as the
 *     message being for us.
 *  3. **Deduplicate.** WeChat re-delivers anything it did not get `success`
 *     for within five seconds, up to three times. `MsgId` for a message,
 *     `FromUserName + CreateTime + Event` for an event (events carry no
 *     `MsgId`), held in Redis for 15 minutes and also as an effects-ledger key
 *     for the durable parts. A replay is answered `success` and does nothing.
 *  4. **Answer inside five seconds.** Anything slow — resolving a scan to a
 *     user, sending a welcome template message — is recorded as an effect and
 *     done after the response. The synchronous part is one transaction.
 *
 * A body we cannot make sense of is still answered `success`: WeChat's only
 * alternative reading of a non-`success` body is "retry", and retrying a
 * message we will never understand three times is worse than dropping it.
 */

/**
 * The handshake WeChat performs when the URL is saved in 公众平台.
 *
 * Note that it is a `GET` with the same signature triple as the `POST`, and
 * that the correct answer is the `echostr` **and nothing else** — no newline,
 * no quotes, no JSON. A server that answers `{"echostr":"..."}` fails the
 * handshake with a message that says only 配置失败.
 */
/** The three parameters every callback carries, plain mode or not. */
const PLAIN_CALLBACK_QUERY = {
  signature: '0f9de62fce790f9a083d5c99e95740ceb90c27ed',
  timestamp: '1767668400',
  nonce: '1372623149',
} as const;

export const wechatOaWebhookVerify = defineRoute({
  id: 'wechatOa.webhookVerify',
  method: 'GET',
  path: '/api/v1/webhooks/wechat-oa',
  auth: 'webhook',
  summary: '公众号服务器地址校验',
  tags: ['wechat-oa', 'webhook'],
  query: z.object({
    signature: z.string(),
    timestamp: z.string(),
    nonce: z.string(),
    echostr: z.string(),
  }),
  response: z.string(),
  examples: [
    {
      name: 'verified',
      query: {
        signature: '0f9de62fce790f9a083d5c99e95740ceb90c27ed',
        timestamp: '1767668400',
        nonce: '1372623149',
        echostr: '5935446184556592210',
      },
      response: '5935446184556592210',
    },
    {
      name: 'bad-signature',
      query: {
        signature: 'deadbeef',
        timestamp: '1767668400',
        nonce: '1372623149',
        echostr: '5935446184556592210',
      },
      response: 'invalid signature',
    },
  ],
});

/**
 * Messages and events.
 *
 * No `body` schema, for the same reason the payment webhooks declare none: the
 * signature in 安全模式 covers the exact bytes, and `handle()` would consume
 * the stream. The route file reads `request.text()` and hands it to
 * `wechat-oa.webhook.service.ts`.
 *
 * The response is either `success` (nothing to say) or an XML reply document
 * produced by the auto-reply engine. Both are `text/xml; charset=utf-8` —
 * WeChat accepts `success` under that content type, and using one code path for
 * both removes the branch that gets the header wrong.
 */
export const wechatOaWebhookEvent = defineRoute({
  id: 'wechatOa.webhookEvent',
  method: 'POST',
  path: '/api/v1/webhooks/wechat-oa',
  auth: 'webhook',
  summary: '公众号消息与事件回调',
  tags: ['wechat-oa', 'webhook'],
  query: z.object({
    signature: z.string(),
    timestamp: z.string(),
    nonce: z.string(),
    /** Present only in 安全模式/兼容模式; it signs the encrypted envelope. */
    msg_signature: z.string().optional(),
    encrypt_type: z.string().optional(),
    openid: z.string().optional(),
  }),
  response: z.string(),
  examples: [
    { name: 'nothing-to-say', query: PLAIN_CALLBACK_QUERY, response: 'success' },
    {
      name: 'keyword-text-reply',
      query: PLAIN_CALLBACK_QUERY,
      response:
        '<xml><ToUserName><![CDATA[oABCDEFGHIJKLMNOPQRSTUVWXYZ]]></ToUserName>' +
        '<FromUserName><![CDATA[gh_1234567890ab]]></FromUserName>' +
        '<CreateTime>1767668400</CreateTime><MsgType><![CDATA[text]]></MsgType>' +
        '<Content><![CDATA[点击 https://shop.example.com/coupons 领取本月优惠券]]></Content></xml>',
    },
    { name: 'replayed-msgid', query: PLAIN_CALLBACK_QUERY, response: 'success' },
    {
      name: 'safe-mode-encrypted',
      query: {
        ...PLAIN_CALLBACK_QUERY,
        msg_signature: '477715d11cdb4164915debcba66cb864d751f3e6',
        encrypt_type: 'aes',
        openid: 'oABCDEFGHIJKLMNOPQRSTUVWXYZ',
      },
      response: 'success',
    },
    {
      name: 'bad-signature',
      query: { ...PLAIN_CALLBACK_QUERY, signature: 'deadbeef' },
      response: 'invalid signature',
    },
  ],
});
