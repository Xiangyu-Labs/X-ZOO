import { defineErrors } from '../_conventions/errors';

/**
 * Order error codes.
 *
 * One code per decision the caller can act on, not per internal branch. The
 * shopper can do something different about "库存不足" and about "地址不存在";
 * they can do nothing different about which of five reasons made a coupon
 * unusable, which is why that one stays a single `COUPON_NOT_USABLE` in the
 * coupon domain.
 *
 * The three cancellation codes are the cancel-vs-pay decision table: when a
 * cancel races a payment, the gateway says `closed` (cancel proceeds), `paid`
 * (`ORDER_ALREADY_PAID`, and the order is marked paid first) or `unknown`
 * (`ORDER_PAYMENT_STATE_UNKNOWN`, and nothing at all is released).
 */
export const orderErrors = defineErrors({
  /** Unknown id, somebody else's order, or hidden by its owner. Same message for all three. */
  ORDER_NOT_FOUND: { status: 404, message: '订单不存在' },

  // --- checkout -----------------------------------------------------------
  /** No cart row was ticked, or every ticked row turned out to be unsellable. */
  ORDER_EMPTY: { status: 422, message: '没有可结算的商品' },
  /** A line's product is deleted, `draft`, `off_shelf`, or its variant is hidden. `details: { skuIds }`. */
  ORDER_ITEM_UNAVAILABLE: { status: 409, message: '部分商品已下架，请重新选择' },
  /**
   * The stock reservation came back short. `details` carries the lines that
   * could not be satisfied, so the client can mark them in place.
   */
  ORDER_OUT_OF_STOCK: { status: 409, message: '部分商品库存不足' },
  /** `products.purchase_limit_mode`. `details: { skuId, limit }`. */
  ORDER_PURCHASE_LIMIT_REACHED: { status: 409, message: '超出该商品的限购数量' },
  /** `products.min_purchase_quantity`. `details: { skuId, minimum }`. */
  ORDER_BELOW_MIN_PURCHASE: { status: 422, message: '未达到该商品的起购数量' },
  /** A `virtual_card` line may only ever carry one unit (SCHEMA.md §3.3). */
  ORDER_VIRTUAL_CARD_QUANTITY: { status: 422, message: '卡密商品每单只能购买 1 件' },
  /** Physical goods with no address chosen and no default address on file. */
  ORDER_ADDRESS_REQUIRED: { status: 422, message: '请选择收货地址' },
  /** The named address does not exist, was deleted, or belongs to somebody else. */
  ORDER_ADDRESS_NOT_FOUND: { status: 404, message: '收货地址不存在' },
  /** A required `products.custom_form` field was not answered. `details: { fields }`. */
  ORDER_CUSTOM_FORM_INCOMPLETE: { status: 422, message: '请填写完整的商品表单' },
  /**
   * `expectedPayableAmount` disagreed with the server's recomputation: a price,
   * a coupon or a freight rule moved between 确认订单 and 提交订单.
   * `details: { expected, actual }`.
   */
  ORDER_PRICE_CHANGED: { status: 409, message: '商品价格有变动，请重新确认订单' },

  // --- cancellation -------------------------------------------------------
  /** The order is not in `pending_payment` any more — already cancelled, or already moving on. */
  ORDER_NOT_CANCELLABLE: { status: 409, message: '订单当前状态不可取消' },
  /**
   * The gateway reported the money arrived while the cancellation was in
   * flight. The order has been marked paid; nothing was released.
   */
  ORDER_ALREADY_PAID: { status: 409, message: '订单已支付，无法取消' },
  /**
   * The gateway would not say whether an attempt can still succeed. Nothing is
   * released — not the stock, not the coupon — and the caller retries later.
   * Never guess: a cancel that released on `unknown` could free the stock of an
   * order that then gets paid (QUEUE-004).
   */
  ORDER_PAYMENT_STATE_UNKNOWN: { status: 409, message: '支付状态确认失败，请稍后重试' },
  /**
   * The coupon could not be returned, so the whole cancellation rolled back —
   * the stock was never touched and the order is still live (QUEUE-006/007).
   */
  ORDER_COUPON_RELEASE_FAILED: { status: 409, message: '优惠券退回失败，请稍后重试' },
});

export type OrderErrorCode = keyof typeof orderErrors;

/**
 * Fulfilment, invoice and console-edit codes.
 *
 * A separate `defineErrors` call in the same file: `pnpm gen` collects one
 * `errors.ts` per domain and flattens every registry it exports, so the
 * fulfilment side keeps its codes apart from checkout's. Same rule as above:
 * one code per decision the caller can act on.
 *
 * The shipping codes are deliberately three, not ten. An operator can do
 * something different about "this order cannot be shipped at all"
 * (`ORDER_NOT_SHIPPABLE`), "you asked for more than is left"
 * (`ORDER_SHIP_QUANTITY_EXCEEDED`) and "that line is not on this order"
 * (`ORDER_SHIP_LINE_INVALID`). They can do nothing different about *which* of
 * the four reasons made the order unshippable, and the conditional update that
 * decides it genuinely cannot tell.
 */
export const orderFulfilErrors = defineErrors({
  // --- shipping -----------------------------------------------------------
  /**
   * Not `paid`, already `fulfilled`, fully refunded, or every remaining line is
   * a `virtual_card` / `virtual_coupon` the paid hook already delivered.
   */
  ORDER_NOT_SHIPPABLE: { status: 409, message: '订单当前状态不可发货' },
  /**
   * More than `quantity - shippedQuantity - refundedQuantity` was asked for on
   * some line — usually a refund landed while the 发货 form was open.
   * `details: { orderItemId, requested, remaining }`.
   */
  ORDER_SHIP_QUANTITY_EXCEEDED: { status: 409, message: '发货数量超过可发货数量' },
  /** An `orderItemId` in the body does not belong to this order. `details: { orderItemIds }`. */
  ORDER_SHIP_LINE_INVALID: { status: 422, message: '发货商品不属于该订单' },
  /** Card keys and coupon goods are delivered by the system when the order is paid. */
  ORDER_VIRTUAL_AUTO_DELIVERED: { status: 409, message: '卡密/优惠券商品由系统自动发货' },
  /** A 拼团 order whose team has not succeeded (RISK-D-011); it ships once the team is full. */
  ORDER_GROUPBUY_NOT_READY: { status: 409, message: '拼团尚未成功，成团后才能发货' },
  /** The shop ran out of unclaimed keys for a `virtual_card` product. `details: { orderItemIds }`. */
  ORDER_VIRTUAL_CARD_EXHAUSTED: { status: 409, message: '卡密库存不足，请补充后重试' },
  ORDER_SHIPMENT_NOT_FOUND: { status: 404, message: '发货单不存在' },
  /** Already cancelled, or the buyer already confirmed receipt. */
  ORDER_SHIPMENT_NOT_EDITABLE: { status: 409, message: '该发货单当前状态不可修改' },
  ORDER_EXPRESS_COMPANY_NOT_FOUND: { status: 404, message: '物流公司不存在' },

  // --- receipt ------------------------------------------------------------
  /** Not `shipped` — already received, still unshipped, cancelled or refunded. */
  ORDER_NOT_RECEIVABLE: { status: 409, message: '订单当前状态不可确认收货' },
  /**
   * `{ via: 'wechat-component' }`, but WeChat's `get_order` does not (yet) say
   * the buyer confirmed — or it could not be asked. `details.verdict`:
   * `not-confirmed` | `unavailable`. The client may retry, or fall back to a
   * plain 确认收货; the settlement push catches up either way.
   */
  ORDER_WECHAT_RECEIPT_UNCONFIRMED: {
    status: 409,
    message: '微信尚未确认收货，请稍后重试',
  },

  // --- console edits ------------------------------------------------------
  /** 改价 is only ever allowed while the order is still `pending_payment`. */
  ORDER_PRICE_NOT_ADJUSTABLE: { status: 409, message: '订单已支付，不能改价' },
  /** The operator discount is larger than the goods total left to discount. `details: { maximum }`. */
  ORDER_PRICE_INVALID: { status: 422, message: '优惠金额超过可优惠的商品总额' },
  /** The parcel is already on its way; changing where it goes is the courier's job now. */
  ORDER_ADDRESS_NOT_EDITABLE: { status: 409, message: '订单已发货，不能修改收货地址' },
  /** Only a finished order (cancelled, completed or refunded) may be removed from the console. */
  ORDER_NOT_DELETABLE: { status: 409, message: '只有已完成、已取消或已退款的订单可以删除' },

  // --- invoices -----------------------------------------------------------
  ORDER_INVOICE_NOT_FOUND: { status: 404, message: '发票申请不存在' },
  /** `order_invoices_open_uq`: one live request per order. */
  ORDER_INVOICE_ALREADY_OPEN: { status: 409, message: '该订单已有开票申请' },
  /** The order has not been paid, or was refunded. */
  ORDER_INVOICE_NOT_REQUESTABLE: { status: 409, message: '该订单当前不可申请开票' },
  /** Already issued, rejected or cancelled. */
  ORDER_INVOICE_NOT_ACTIONABLE: { status: 409, message: '该开票申请当前状态无法执行此操作' },
  /** WeChat's 内容安全 judged the 抬头 name `risky` (C09); fail-open when WeChat is unreachable. */
  ORDER_INVOICE_TITLE_REJECTED: { status: 422, message: '发票抬头包含不当信息，请修改后再提交' },
});

export type OrderFulfilErrorCode = keyof typeof orderFulfilErrors;
