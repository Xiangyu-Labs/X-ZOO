import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * `wechat-oa-runtime` — the parts of Official Account behaviour that are ours
 * rather than WeChat's.
 *
 * The credentials are **not** here. They live in two groups this domain does
 * not own and deliberately does not duplicate:
 *
 * | What | Group | Owner |
 * | --- | --- | --- |
 * | `appId` / `appSecret`, API base URL | `wechat` | `wechat` |
 * | operator-facing token, EncodingAESKey, 消息加解密方式 | `wechat-oa` | `system` |
 *
 * `credentials.ts` reads both and prefers the `wechat-oa` group's, because that
 * is the screen an operator actually fills in; `wechat.oaToken` is the
 * fallback.
 *
 * What is left is genuinely ours: which domains a JS-SDK signature may be
 * issued for, and which subscribe-template ids the storefront should ask
 * permission for at which moment.
 */
export const wechatOaRuntimeConfig = defineConfigGroup({
  group: 'wechat-oa-runtime',
  title: '公众号行为',
  description: 'JS-SDK 授权域名、扫码去重与模板消息 ID。',
  category: 'wechat',
  permission: 'system:config:read',
  schema: z.object({
    /**
     * Hosts a JS-SDK signature may be issued for, comma separated.
     *
     * Signing whatever URL we are handed would turn our jsapi ticket into a
     * signing oracle for anybody's page. Empty means "only the site's own
     * origin", which is the safe default even though it makes a fresh install
     * answer `WECHAT_OA_URL_NOT_ALLOWED` until somebody fills it in — a visible
     * refusal beats a silent one.
     */
    jsApiAllowedHosts: z.string().max(1024).default(''),
    /**
     * How long a scan may be counted again for the same openid and QR code.
     *
     * WeChat re-delivers a `SCAN` event on every retry and a poster gets
     * photographed and re-scanned by the same phone all afternoon; without a
     * window the counter measures patience rather than reach.
     */
    scanDedupeSeconds: z.number().int().min(0).max(86_400).default(300),
    /** Subscribe-message template ids per storefront scene, comma separated. */
    subscribeOrderCreate: z.string().max(512).default(''),
    subscribeOrderPay: z.string().max(512).default(''),
    subscribeOrderUnpaid: z.string().max(512).default(''),
    subscribeOrderShip: z.string().max(512).default(''),
    subscribeRefund: z.string().max(512).default(''),
  }),
  ui: {
    jsApiAllowedHosts: {
      label: 'JS-SDK 授权域名',
      type: 'text',
      help: '多个域名用英文逗号分隔，留空表示仅允许站点自身域名',
      section: 'JS-SDK',
      order: 10,
    },
    scanDedupeSeconds: {
      label: '扫码去重窗口',
      type: 'number',
      unit: 'seconds',
      section: '渠道码',
      order: 20,
    },
    subscribeOrderCreate: {
      label: '下单场景模板 ID',
      type: 'text',
      section: '订阅消息',
      order: 30,
    },
    subscribeOrderPay: { label: '支付场景模板 ID', type: 'text', section: '订阅消息', order: 31 },
    subscribeOrderUnpaid: {
      label: '待付款提醒模板 ID',
      type: 'text',
      help: '提交订单时请买家授权，订单超时取消前发送；需与消息管理中「未付款提醒」的小程序模板 ID 一致',
      section: '订阅消息',
      order: 32,
    },
    subscribeOrderShip: { label: '发货场景模板 ID', type: 'text', section: '订阅消息', order: 33 },
    subscribeRefund: { label: '退款场景模板 ID', type: 'text', section: '订阅消息', order: 34 },
  },
});

export type WechatOaRuntimeConfig = z.infer<typeof wechatOaRuntimeConfig.schema>;
