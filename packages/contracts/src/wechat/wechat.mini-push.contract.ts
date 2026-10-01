import { z } from 'zod';
import { defineRoute } from '../_conventions/route';

/**
 * The mini program's 消息推送, `/api/v1/webhooks/wechat-mini` (C07, C09).
 *
 * 公众平台 → 开发管理 → 消息推送: this URL, the Token and EncodingAESKey from
 * the `wechat` settings, 数据格式 **JSON**. The route files build their
 * `Response` themselves, as the Official Account callback's do: the handshake
 * wants the bare `echostr`, a push wants the bare `success`.
 *
 * The order is the security model: the signature (and in 安全/兼容模式 the
 * `msg_signature` over the ciphertext) is checked before the body is parsed
 * beyond reading the `Encrypt` field; the `(timestamp, nonce)` pair is fresh and
 * single-use; the envelope's appid must be ours. A push that fails any of them
 * is `403 invalid signature` and nothing is written. In 明文/兼容模式, with the
 * nonce store down, a push is `503` (WeChat re-delivers it later) because
 * nothing would tie its signature to its body. A genuine push is one
 * effects-ledger row (deduplicated by the decrypted message's hash) and
 * `success`; what it causes happens after the answer.
 */

const CALLBACK_QUERY = {
  signature: '0f9de62fce790f9a083d5c99e95740ceb90c27ed',
  timestamp: '1767668400',
  nonce: '1372623149',
} as const;

export const wechatMiniWebhookVerify = defineRoute({
  id: 'wechat.miniWebhookVerify',
  method: 'GET',
  path: '/api/v1/webhooks/wechat-mini',
  auth: 'webhook',
  summary: '小程序消息推送地址校验',
  tags: ['wechat', 'webhook'],
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
      query: { ...CALLBACK_QUERY, echostr: '5935446184556592210' },
      response: '5935446184556592210',
    },
    {
      name: 'bad-signature',
      query: { ...CALLBACK_QUERY, signature: 'deadbeef', echostr: '5935446184556592210' },
      response: 'invalid signature',
    },
  ],
});

/** No `body` schema: the signature covers the exact bytes, which `handle()` would consume. */
export const wechatMiniWebhookEvent = defineRoute({
  id: 'wechat.miniWebhookEvent',
  method: 'POST',
  path: '/api/v1/webhooks/wechat-mini',
  auth: 'webhook',
  summary: '小程序消息推送（发货信息管理、内容安全）',
  tags: ['wechat', 'webhook'],
  query: z.object({
    signature: z.string(),
    timestamp: z.string(),
    nonce: z.string(),
    /** 安全模式 / 兼容模式 only: signs the encrypted envelope. */
    msg_signature: z.string().optional(),
    encrypt_type: z.string().optional(),
    openid: z.string().optional(),
  }),
  response: z.string(),
  examples: [
    { name: 'recorded', query: CALLBACK_QUERY, response: 'success' },
    {
      name: 'safe-mode',
      query: {
        ...CALLBACK_QUERY,
        msg_signature: '477715d11cdb4164915debcba66cb864d751f3e6',
        encrypt_type: 'aes',
      },
      response: 'success',
    },
    {
      name: 'bad-signature',
      query: { ...CALLBACK_QUERY, signature: 'deadbeef' },
      response: 'invalid signature',
    },
  ],
});
