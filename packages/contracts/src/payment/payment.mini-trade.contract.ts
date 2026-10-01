import { z } from 'zod';
import { instant } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import { orderRefParams } from '../order/order.ref.schemas';

/**
 * 小程序发货信息管理 (C07): what the storefront and the admin see of it.
 *
 * The uploads themselves have no route — they are effects of a shipment — and
 * WeChat's pushes arrive on `/api/v1/webhooks/wechat-mini`
 * (`wechat.mini-push.contract.ts`).
 */

// ---------------------------------------------------------------------------
// storefront: before opening WeChat's 确认收货 component
// ---------------------------------------------------------------------------

/**
 * What `wx.openBusinessView({ businessType: 'weappOrderConfirm', extraData })`
 * takes, in our spelling: WeChat's `transaction_id`, or `merchant_id` +
 * `merchant_trade_no`. The client maps it to WeChat's snake_case keys.
 */
export const wechatReceiptExtraData = z.union([
  z.object({ transactionId: z.string() }),
  z.object({ merchantId: z.string(), merchantTradeNo: z.string() }),
]);
export type WechatReceiptExtraData = z.infer<typeof wechatReceiptExtraData>;

export const wechatReceiptResult = z.object({
  /**
   * `null` when the component cannot be used for this order — not paid in the
   * mini program, not (fully) reported to WeChat, or not `shipped` — and the
   * client uses the plain `order.confirmReceipt` instead.
   */
  receipt: wechatReceiptExtraData.nullable(),
});
export type WechatReceiptResult = z.infer<typeof wechatReceiptResult>;

/**
 * The server-side check before the client opens WeChat's component: the order
 * is the signed-in shopper's own (a stranger's is `ORDER_NOT_FOUND`, AUTH-005),
 * it was paid in the mini program, and WeChat has been told it is all out.
 * Only then does the client get the payment's WeChat number to hand to
 * `openBusinessView`.
 */
export const paymentWechatReceipt = defineRoute({
  id: 'payment.wechatReceipt',
  method: 'GET',
  path: '/api/v1/orders/:id/wechat-receipt',
  auth: 'user',
  summary: '微信确认收货组件参数',
  tags: ['payment', 'order'],
  params: orderRefParams,
  response: wechatReceiptResult,
  errors: ['ORDER_NOT_FOUND'],
  examples: [
    {
      name: 'reported',
      params: { id: '9001' },
      response: { receipt: { transactionId: '4200001234202602021234567890' } },
    },
    { name: 'not-a-mini-program-payment', params: { id: '9001' }, response: { receipt: null } },
  ],
});

// ---------------------------------------------------------------------------
// admin: 小程序发货信息管理 status and 同步
// ---------------------------------------------------------------------------

export const miniTradeStatus = z.object({
  /** 录入发货信息 (`wechat-mini-trade.uploadEnabled`). */
  uploadEnabled: z.boolean(),
  /** `is_trade_managed` as of `managedCheckedAt`; `null` = never asked. */
  managed: z.boolean().nullable(),
  managedCheckedAt: instant.nullable(),
  /** The 消息跳转路径 WeChat was last told, and when. */
  msgJumpPath: z.string().nullable(),
  msgJumpPathSetAt: instant.nullable(),
  /** What it should be: the order page, opened by `outTradeNo`. */
  expectedMsgJumpPath: z.string(),
});
export type MiniTradeStatus = z.infer<typeof miniTradeStatus>;

const statusExample: MiniTradeStatus = {
  uploadEnabled: true,
  managed: true,
  managedCheckedAt: '2026-09-23T10:00:00+08:00',
  msgJumpPath: 'packages/order/detail/index?outTradeNo=${商品订单号}',
  msgJumpPathSetAt: '2026-09-23T10:00:00+08:00',
  expectedMsgJumpPath: 'packages/order/detail/index?outTradeNo=${商品订单号}',
};

export const paymentMiniTradeStatus = defineRoute({
  id: 'payment.miniTradeStatus',
  method: 'GET',
  path: '/admin-api/wechat-mini-trade',
  auth: 'admin',
  permission: 'payment:config:write',
  summary: '小程序发货信息管理状态',
  tags: ['payment', 'wechat'],
  response: miniTradeStatus,
  examples: [
    { name: 'synced', response: statusExample },
    {
      name: 'never-synced',
      response: {
        ...statusExample,
        managed: null,
        managedCheckedAt: null,
        msgJumpPath: null,
        msgJumpPathSetAt: null,
      },
    },
  ],
});

/**
 * 同步: asks WeChat `is_trade_managed`, and sets the 消息跳转路径
 * (`set_msg_jump_path`) to the order page. An operator presses it once the
 * mini program's credentials are in and after each release that moves the
 * order page; it is idempotent.
 */
export const paymentMiniTradeSync = defineRoute({
  id: 'payment.miniTradeSync',
  method: 'POST',
  path: '/admin-api/wechat-mini-trade/sync',
  auth: 'admin',
  permission: 'payment:config:write',
  // Payment configuration is changed from the console only, never with an API
  // token (AUTH-012) — the same rule the payment settings groups follow.
  consoleOnly: true,
  summary: '同步小程序发货信息管理',
  tags: ['payment', 'wechat'],
  body: z.object({}).default({}),
  response: miniTradeStatus,
  errors: ['PAYMENT_MINI_TRADE_SYNC_FAILED', 'PAYMENT_MINI_NOT_CONFIGURED'],
  examples: [{ name: 'ok', body: {}, response: statusExample }],
});
