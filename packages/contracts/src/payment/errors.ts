import { defineErrors } from '../_conventions/errors';

/**
 * Payment error codes.
 *
 * One code per decision the caller can act on, not per internal branch. Two
 * groups matter:
 *
 *  - **409s are ordinary traffic.** A shopper double-tapping 支付 while a
 *    callback settles the order is not an incident; it is a race whose losing
 *    side gets `PAYMENT_ORDER_ALREADY_PAID` and a screen that says 已支付.
 *  - **`PAYMENT_STATE_UNKNOWN` is never a guess.** When the gateway did not
 *    answer, the only honest reply is "we do not know yet, nothing was
 *    released" (PAYC-002 / QUEUE-004). Turning an unknown into a `closed` is
 *    the defect this whole domain exists to prevent, so it has its own code.
 *    Shoppers read its message at the cashier, so it says what to do (look
 *    again shortly) rather than 「人工核对」; the operator's detail is in logs.
 */
export const paymentErrors = defineErrors({
  /** The order does not exist, is soft-deleted, or belongs to somebody else. Same message either way. */
  PAYMENT_ORDER_NOT_FOUND: { status: 404, message: '订单不存在' },
  /** The order is cancelled, refunded, or otherwise past the point of paying. */
  PAYMENT_ORDER_NOT_PAYABLE: { status: 409, message: '该订单当前无法支付' },
  /** Already settled. The client shows 已支付 and refreshes rather than opening a cashier. */
  PAYMENT_ORDER_ALREADY_PAID: { status: 409, message: '订单已支付，请刷新后查看' },
  /** `pay_expires_at` has passed; the order is on its way to being cancelled. */
  PAYMENT_ORDER_EXPIRED: { status: 409, message: '订单支付已超时，请重新下单' },

  /**
   * A live attempt exists whose frozen fields disagree with this request
   * (PAYC-004): a different channel, amount, merchant or payer. The stored row
   * is untouched and a human decides. An *identical* replay is not an error —
   * it returns the same intent.
   */
  PAYMENT_ATTEMPT_CONFLICT: {
    status: 409,
    message: '该订单已有一笔支付正在进行，请稍后刷新订单查看',
  },
  /** The merchant order number is unknown, or belongs to another shopper. */
  PAYMENT_ATTEMPT_NOT_FOUND: { status: 404, message: '支付记录不存在' },

  /**
   * `wechat_mini` / `wechat_oa` without an openid: no bound WeChat identity and
   * none supplied. The client re-runs its authorisation flow.
   */
  PAYMENT_OPENID_REQUIRED: { status: 422, message: '请先完成微信授权后再支付' },
  /** The requested channel does not match `X-Client-Platform`, or is not configured. */
  PAYMENT_CHANNEL_UNAVAILABLE: { status: 409, message: '当前客户端不支持该支付方式' },
  /** `returnUrl` pointed somewhere other than this shop. */
  PAYMENT_RETURN_URL_INVALID: { status: 422, message: '回跳地址不合法' },

  /** The `payment` config group is incomplete: no merchant id, key, serial or notify URL. */
  PAYMENT_NOT_CONFIGURED: { status: 503, message: '支付尚未配置，请联系管理员' },
  /** The gateway refused the create/query/close/refund with a business code. `details` carries it. */
  PAYMENT_GATEWAY_REFUSED: { status: 502, message: '支付网关拒绝了本次请求，请稍后重试' },
  /**
   * 小程序发货信息管理's 同步 (`is_trade_managed` / `set_msg_jump_path`): WeChat
   * answered with an `errcode`. `details`: `{ step, errcode }`; the message says
   * what the code means in Chinese, and WeChat's `errmsg` is logged.
   */
  PAYMENT_MINI_TRADE_SYNC_FAILED: { status: 502, message: '同步微信发货信息管理失败，请稍后重试' },
  /** The mini program's AppID / AppSecret are not filled in, so WeChat cannot be asked anything. */
  PAYMENT_MINI_NOT_CONFIGURED: {
    status: 409,
    message: '请先在「微信公众号 / 小程序」设置中填写小程序 AppID 与 AppSecret',
  },
  /**
   * The gateway did not answer, or answered something we refuse to trust
   * (bad signature, unfetchable platform certificate). Nothing is released.
   */
  PAYMENT_STATE_UNKNOWN: { status: 409, message: '支付结果确认中，请稍后刷新查看' },

  /** The stored merchant identity no longer matches the configuration (PAYC-005). */
  PAYMENT_MERCHANT_MISMATCH: { status: 409, message: '支付商户信息不一致，请人工核对后处理' },

  /** The exception row is gone, or already resolved. */
  PAYMENT_EXCEPTION_NOT_FOUND: { status: 404, message: '异常支付记录不存在' },
  /** An operator asked to refund or ignore an exception that is no longer `open`. */
  PAYMENT_EXCEPTION_NOT_ACTIONABLE: { status: 409, message: '该异常记录当前状态无法执行此操作' },
  /** An exception with no transaction id cannot be refunded through the original channel. */
  PAYMENT_EXCEPTION_NOT_REFUNDABLE: {
    status: 409,
    message: '该异常记录缺少交易号，只能线下处理',
  },

  /** The effect row is gone, or the retry console was pointed at another domain's scope. */
  PAYMENT_EFFECT_NOT_FOUND: { status: 404, message: '待处理任务不存在' },
});

export type PaymentErrorCode = keyof typeof paymentErrors;
