// Before `order.fulfil.effects`: both install a paid hook on import, and the
// sale has to be committed first (see `order.stock.hooks.ts`).
import { installStockCommitHook } from './order.stock.hooks';
import { installFulfilmentHooks } from './order.fulfil.effects';
import { orderFacts } from './order.facts.repo';
import { orderStateMachine } from './order.state-machine';
import { registerOrderFacts, registerOrderStateMachine } from './ports';

/**
 * The order domain's public surface.
 *
 * `docs/conventions.md`: "A domain in `core` may import another domain only
 * through that domain's `index.ts`". So this file is the contract between the
 * order aggregate and everybody else, and `order.repo.ts` in particular is
 * private.
 *
 * | Export                | Caller | When                                       |
 * | --------------------- | ------ | ------------------------------------------ |
 * | `preview` / `create`  | routes | 确认订单 / 提交订单                         |
 * | `cancel`              | routes | 取消订单                                    |
 * | `cancelOrder`         | payment, fulfilment | payment failed, admin close-out |
 * | `autoCancel` / `sweepExpiredOrders` | jobs | the payment window closed     |
 * | `remindUnpaid`        | jobs   | 未付款提醒, before the window closes        |
 * | `list` / `counts` / `detail` | routes | 我的订单                             |
 * | `hide`                | routes | 删除订单 (visibility only)                  |
 * | `rebuyLines`          | cart   | 再次购买                                    |
 * | `resolveCatalogPort`  | cart   | live price, stock and status of a variant   |
 *
 * **Direction of dependency.** The cart imports the order domain; the order
 * domain never imports the cart. That is why the catalogue seam
 * (`catalog.port.ts`, the read interface the catalog implements) is re-exported
 * from here, and why the two `cart_items` statements checkout needs live in
 * `order.repo.ts`.
 */

/**
 * Everything the order domain registers, in one idempotent call (the shape
 * `@shop/core/domains` looks for): the state machine the payment, refund,
 * fulfilment and kind-handler code reach through `getOrderStateMachine()`; the
 * `OrderFactsPort` the catalog asks about purchases and reviewable lines; and
 * the order-paid hooks —
 * the stock commit that turns the reservation into a sale, then auto-delivery —
 * that have to be installed before the first payment lands. Importing the
 * domain calls it once; a test that `resetOrderPorts()` calls it again.
 */
export function registerOrderDomain(): void {
  registerOrderStateMachine(orderStateMachine);
  registerOrderFacts(orderFacts);
  installStockCommitHook();
  installFulfilmentHooks();
}

registerOrderDomain();

export { create, preview, rebuyLines } from './order.checkout.service';
export { autoCancel, cancel, cancelOrder, sweepExpiredOrders } from './order.cancel.service';
export { remindUnpaid } from './order.remind.service';
export type { CancelInput, CancelOutcome, CancelReason } from './order.cancel.service';
export { counts, detail, detailOf, giftCoupons, list } from './order.query.service';
export { hide } from './order.hide.service';
export { ORDER_NO_LENGTH, isOrderNo, requireOrderRef, resolveOrderRef } from './order.ref';
export { orderStateMachine } from './order.state-machine';
export { orderConfig } from './order.config';

/**
 * The pricing split, exactly as `create` applies it.
 *
 * Pure, and exported because a marketing domain's tests have to be able to
 * build the same `PricingDraft.adjustments` this service hands to
 * `beforeCreate`. A driver that skipped the clamping would be testing a kind
 * handler's guard against a draft no real checkout produces.
 */
export { splitAdjustments } from './order.pricing';
export type { AppliedAdjustment, DiscountSplit } from './order.pricing';

/** The catalogue seam: the read interface the catalog domain registers into. */
export {
  registerCatalogPort,
  resolveCatalogPort,
  resolveFreightPort,
  resolvePaymentPort,
  resolveStockPort,
  resetCatalogPort,
  peekCatalogPort,
} from './catalog.port';
export type {
  CatalogPort,
  CustomFormField,
  FreightMode,
  ProductKind,
  PurchaseLimitMode,
  SkuForSale,
} from './catalog.port';

// ---------------------------------------------------------------------------
// fulfilment, the admin console, invoices
// ---------------------------------------------------------------------------

export { orderPermissions } from './permissions';
export { orderFulfilConfig } from './order.fulfil.config';

export {
  adminShip,
  adminTrackShipment,
  autoReceive,
  cancelShipment,
  completeOrder,
  confirmReceipt,
  myShipments,
  myShipmentTracking,
  receiveOrder,
  shipOrder,
  shipmentsOfOrder,
  sweepAutoReceive,
  sweepCompletions,
  requireOwnOrder,
  shipmentReportFacts,
  trackShipment,
  updateShipment,
} from './order.fulfil.service';
export type {
  ReceiptInput,
  ReceiptOutcome,
  ShipInput,
  ShipmentReportFacts,
} from './order.fulfil.service';

export * as orderConsole from './order.console.service';
export * as orderInvoices from './order.invoice.service';

// `installFulfilmentHooks` is re-exported for the reason it exists at all: a
// test in another domain that calls `resetOrderPorts()` clears the order-paid
// hook along with everything else, and the boundary rule means it can only
// reach it through this file.
export { autoDeliver, installFulfilmentHooks } from './order.fulfil.effects';

/** The seams fulfilment needs from other domains (logistics, notification). */
export {
  registerFulfilmentNotifier,
  registerLogisticsPort,
  registerWechatReceiptVerifier,
  resetFulfilmentPorts,
  resolveFulfilmentNotifier,
  resolveLogisticsPort,
  resolveWechatReceiptVerifier,
} from './order.fulfil.ports';
export type {
  FulfilmentNotice,
  FulfilmentNoticeOrder,
  FulfilmentNoticeShipment,
  FulfilmentNotifier,
  LogisticsPort,
  TrackingResult,
  TrackingTrace,
  WechatReceiptVerdict,
  WechatReceiptVerifier,
} from './order.fulfil.ports';
