import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';
import type { Ctx } from '../kernel/context';
import {
  createWechatPayClient,
  isPaymentConfigured,
  type WechatPayClient,
  type WechatPayCredentials,
} from '../wechat';

/**
 * The `payment` config group: WeChat Pay v3 merchant credentials.
 *
 * WeChat Pay v3 is the only gateway (`docs/conventions.md` §Scope guard), so
 * there is no driver selector here — no switch between v2 and v3 channels
 * (GATEWAY-002), because v2 is not supported.
 *
 * Every secret is `secret: true`: the admin form receives an "is set" boolean
 * and plaintext only travels back when an operator retypes it. Nothing in this
 * group is ever written to a log — `wechat.pay.ts` builds its log objects from
 * the path, the merchant order number and the gateway's own error code, never
 * from this object.
 */

/**
 * A stored text setting.
 *
 * `config_values.value` is `jsonb`, and a string written to it must come back a
 * string even when it is all digits — a 商户号, a phone number. Parsing the
 * value twice on the way out would turn it into a *number*; `@shop/db` has json
 * and jsonb reach drizzle as text and parses them once, so this is a plain
 * string. The round trip is covered by a test in every group this domain owns,
 * because the failure mode is silent: the field falls back to its default and
 * the shop reports 支付尚未配置 with a filled-in form.
 */
const configText = (max: number) => z.string().max(max).default('');

export const paymentConfig = defineConfigGroup({
  group: 'payment',
  title: '微信支付',
  description: '微信支付商户号、APIv3 密钥、证书与支付有效期。',
  category: 'trade',
  permission: 'payment:config:write',
  schema: z.object({
    /** The merchant id. Recorded on every attempt so a later config change is detectable (PAYC-005). */
    mchId: configText(64),
    /** APIv3 key: exactly 32 characters, used for AEAD_AES_256_GCM. */
    apiV3Key: configText(64),
    /** Serial number of the merchant API certificate, sent in every Authorization header. */
    certSerial: configText(64),
    /** PKCS#8 PEM. Never leaves the server. */
    merchantPrivateKey: configText(4096),
    /**
     * WeChat is migrating from a rotating platform *certificate* to a published
     * platform *public key*. Both are verified identically and both are keyed by
     * the id WeChat puts in `Wechatpay-Serial`, so one pair of fields covers
     * both modes: paste the key id and the PEM.
     */
    platformPublicKeyId: configText(64),
    platformPublicKey: configText(4096),
    /**
     * Where WeChat sends callbacks. Must be HTTPS and reachable from the
     * internet; the two webhook paths are appended to it.
     */
    notifyBaseUrl: configText(255),
    /** How long a payment attempt stays collectible at the gateway. */
    payExpiryMinutes: z.number().int().min(5).max(120).default(30),
    /**
     * `api.mch.weixin.qq.com`, overridable so an integration test can point the
     * client at the fake gateway. No `ui` entry, so the admin form never
     * renders it.
     */
    apiBaseUrl: z.string().max(255).default('https://api.mch.weixin.qq.com'),
  }),
  status: (c) => {
    if (isPaymentConfigured(paymentCredentials(c)))
      return { tone: 'on', text: `商户号 ${c.mchId}` };
    const touched = [c.mchId, c.apiV3Key, c.certSerial, c.merchantPrivateKey].some((v) => v !== '');
    return touched ? { tone: 'incomplete', text: '未填完' } : { tone: 'off', text: '未配置' };
  },
  ui: {
    mchId: { label: '商户号', type: 'text', section: '微信支付', order: 10 },
    apiV3Key: {
      label: 'APIv3 密钥',
      type: 'password',
      secret: true,
      help: '32 位字符，在商户平台设置',
      section: '微信支付',
      order: 20,
    },
    certSerial: {
      label: 'API 证书序列号',
      type: 'text',
      section: '微信支付',
      order: 30,
    },
    merchantPrivateKey: {
      label: '商户 API 私钥',
      type: 'password',
      secret: true,
      help: 'apiclient_key.pem 的完整内容',
      section: '微信支付',
      order: 40,
    },
    platformPublicKeyId: {
      label: '微信支付公钥 ID',
      type: 'text',
      help: '公钥模式填公钥 ID，证书模式填平台证书序列号',
      section: '微信支付',
      order: 50,
    },
    platformPublicKey: {
      label: '微信支付公钥',
      type: 'textarea',
      secret: true,
      help: '用于验证微信的应答与回调签名',
      section: '微信支付',
      order: 60,
    },
    notifyBaseUrl: {
      label: '回调域名',
      type: 'text',
      placeholder: 'https://shop.example.com',
      help: '必须是 https，且可被微信服务器访问',
      section: '微信支付',
      order: 70,
    },
    payExpiryMinutes: {
      label: '支付有效期',
      type: 'number',
      unit: 'minutes',
      section: '微信支付',
      order: 80,
    },
  },
});

export type PaymentConfig = z.infer<typeof paymentConfig.schema>;

/** The two webhook paths, appended to `notifyBaseUrl`. Single source of truth. */
export const NOTIFY_PATHS = {
  transaction: '/api/v1/webhooks/wechat-pay',
  refund: '/api/v1/webhooks/wechat-refund',
} as const;

/**
 * Turns the stored group into what the gateway client needs.
 *
 * The declared return type is what keeps `WechatPayCredentials` — which
 * `wechat.pay.ts` declares locally, because it must not import this file —
 * honest: add a field there and this function stops compiling.
 *
 * `notifyBaseUrl` is joined here and nowhere else. A trailing slash in the
 * admin form is the operator's most likely mistake and would produce
 * `https://shop.example.com//api/...`, which WeChat will happily call and the
 * Next.js router will not match.
 */
export function paymentCredentials(config: PaymentConfig): WechatPayCredentials {
  const base = config.notifyBaseUrl.replace(/\/+$/, '');
  return {
    mchId: config.mchId,
    apiV3Key: config.apiV3Key,
    certSerial: config.certSerial,
    merchantPrivateKey: config.merchantPrivateKey,
    platformPublicKeyId: config.platformPublicKeyId,
    platformPublicKey: config.platformPublicKey,
    transactionNotifyUrl: base === '' ? '' : `${base}${NOTIFY_PATHS.transaction}`,
    refundNotifyUrl: base === '' ? '' : `${base}${NOTIFY_PATHS.refund}`,
    apiBaseUrl: config.apiBaseUrl,
  };
}

/** The pay client for this request, built from the current `payment` group. */
export async function getWechatPayClient(ctx: Ctx): Promise<WechatPayClient> {
  return createWechatPayClient(ctx, paymentCredentials(await ctx.config.get(paymentConfig)));
}

/** `true` when an operator has finished filling the `payment` form. */
export async function isPaymentEnabled(ctx: Ctx): Promise<boolean> {
  return isPaymentConfigured(paymentCredentials(await ctx.config.get(paymentConfig)));
}
