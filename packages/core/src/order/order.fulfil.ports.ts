import type { Ctx } from '../kernel/context';

/**
 * The seams fulfilment needs from other domains: courier tracking and
 * notifications.
 *
 * They follow the shape `ports.ts` already established — a slot, a registrar
 * and a `resolve*` that returns `undefined` rather than throwing — because the
 * console has to work without them. The difference from `ports.ts`'s slots is
 * deliberate: a missing `StockPort` is a bug, a missing logistics provider is
 * Tuesday.
 */

// ---------------------------------------------------------------------------
// logistics (the shipping domain)
// ---------------------------------------------------------------------------

export interface TrackingTrace {
  at: Date;
  context: string;
}

export interface TrackingResult {
  state: 'unknown' | 'in_transit' | 'delivering' | 'delivered' | 'exception';
  traces: TrackingTrace[];
}

/**
 * `shipping`'s courier lookup. Implemented by the shipping domain over
 * 阿里云云市场; fulfilment only ever asks and renders.
 */
export interface LogisticsPort {
  track(
    ctx: Ctx,
    input: { companyCode: string; trackingNo: string; phone?: string },
  ): Promise<TrackingResult>;
}

let logistics: LogisticsPort | undefined;

export function registerLogisticsPort(impl: LogisticsPort): void {
  logistics = impl;
}

/**
 * `undefined` means no provider is configured, and the contract has a field for
 * exactly that (`shipmentTracking.available`). An empty array for both cases
 * would leave an operator unable to tell "not configured" from "not scanned
 * yet", and they would open a ticket about the courier.
 */
export function resolveLogisticsPort(): LogisticsPort | undefined {
  return logistics;
}

// ---------------------------------------------------------------------------
// notifications (the notification domain)
// ---------------------------------------------------------------------------

export interface FulfilmentNotice {
  kind: 'shipment.dispatched' | 'order.received' | 'order.completed' | 'virtual.delivered';
  orderId: number;
  userId: number;
  /** The effect row's payload as it was recorded; ids only (see `order` and `shipment`). */
  payload: Record<string, unknown>;
  /**
   * The order as it stands when the handler runs. Read then rather than frozen
   * into the effect, so a row recorded before these fields existed is told the
   * same thing as a new one, and a retry hours later reads what is true now.
   * `null` when the order is gone.
   */
  order: FulfilmentNoticeOrder | null;
  /** `shipment.dispatched` only: the parcel the effect is about. */
  shipment: FulfilmentNoticeShipment | null;
}

export interface FulfilmentNoticeOrder {
  orderNo: string;
  /** What the buyer paid, `"12.00"`; `null` before payment. */
  paidAmount: string | null;
}

export interface FulfilmentNoticeShipment {
  id: number;
  deliveryMode: 'express' | 'merchant_delivery' | 'virtual';
  /** The carrier's name (`express`), enabled or not. */
  expressCompanyName: string | null;
  trackingNo: string | null;
  /** `merchant_delivery` only. */
  courierName: string | null;
  courierPhone: string | null;
}

/**
 * Where "your parcel is on its way" goes.
 *
 * It is behind the **effects ledger**, not called inline, because it is the one
 * part of shipping that talks to somebody else's server. No notifier registered
 * means the handler logs and returns — which must stay a success, or every
 * shipment parks an effect row for a human who cannot do anything about it.
 */
export interface FulfilmentNotifier {
  notify(ctx: Ctx, notice: FulfilmentNotice): Promise<void>;
}

let notifier: FulfilmentNotifier | undefined;

export function registerFulfilmentNotifier(impl: FulfilmentNotifier): void {
  notifier = impl;
}

export function resolveFulfilmentNotifier(): FulfilmentNotifier | undefined {
  return notifier;
}

// ---------------------------------------------------------------------------
// WeChat's 确认收货 component (the payment domain)
// ---------------------------------------------------------------------------

/**
 * `confirmed`: WeChat's `get_order` says the buyer confirmed receipt of this
 * order's mini-program payment. `not-confirmed`: WeChat answered, and it has
 * not. `unavailable`: there is nobody to ask — not a mini-program payment, not
 * reported to WeChat, or WeChat did not answer.
 */
export type WechatReceiptVerdict = 'confirmed' | 'not-confirmed' | 'unavailable';

/**
 * Asked before `{ via: 'wechat-component' }` moves an order: WeChat's own rule
 * is that the component's `success` callback must be checked with `get_order`
 * before the merchant believes it (C07). The payment domain implements it,
 * because the payment is what WeChat knows the order by.
 */
export interface WechatReceiptVerifier {
  verify(ctx: Ctx, input: { orderId: number }): Promise<WechatReceiptVerdict>;
}

let receiptVerifier: WechatReceiptVerifier | undefined;

export function registerWechatReceiptVerifier(impl: WechatReceiptVerifier): void {
  receiptVerifier = impl;
}

export function resolveWechatReceiptVerifier(): WechatReceiptVerifier | undefined {
  return receiptVerifier;
}

/** Test helper. Never call this from app code. */
export function resetFulfilmentPorts(): void {
  logistics = undefined;
  notifier = undefined;
  receiptVerifier = undefined;
}
