import type { Tx } from '@shop/db';
import type { DbOrTx } from '@shop/db';
import type { Ctx } from '../kernel/context';
import type { Money } from '../kernel/money';
import { DomainError } from '../kernel/errors';

/**
 * The cross-domain seams of the order aggregate.
 *
 * Several domains touch an order without owning it: payment and refund,
 * fulfilment, group-buy and presale, catalog stock, freight. If they reached
 * into each other's tables every change to one would ripple through the others,
 * so this file is the *only* thing they share.
 *
 * Everything here is an interface, a type, or a registry. There is no
 * behaviour: the implementations are registered by their owning domain
 * (`registerStockPort` from catalog, `registerPaymentPort` from payment, …) and
 * the fakes for tests live in `@shop/testing`.
 *
 * Rules that are not negotiable:
 *  - a transition is a **conditional update**, decided on the affected row
 *    count, never a read-then-write, so two concurrent requests (a
 *    double-tapped 收货, two operators shipping the same order) cannot both win;
 *  - hooks run **inside** the caller's transaction and may only touch the
 *    database — anything that calls a third party records an effect instead
 *    (`docs/conventions.md`: "never inside the transaction");
 *  - hooks must be **idempotent**, because the effect ledger retries.
 */

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * The order lifecycle. Refund state is *not* here: a refund is its own
 * aggregate owned by the refund domain, and an order carries a denormalised
 * `refundStatus` alongside this one.
 */
export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'shipped',
  'received',
  'completed',
  'cancelled',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** `from -> allowed to`. A status absent from the table is terminal. */
export type TransitionTable<S extends string> = Readonly<Partial<Record<S, readonly S[]>>>;

/**
 * The canonical table. The order domain owns the behaviour; the shape lives
 * here so the kind handlers and the payment and refund domains can write their
 * guards against it without importing the order service.
 */
export const ORDER_TRANSITIONS: TransitionTable<OrderStatus> = Object.freeze({
  // Mirrors the `orders_status` enum and its diagram in
  // `db/src/schema/order.ts`. Only an unpaid order is cancelled; a paid one
  // leaves through a full refund.
  pending_payment: ['paid', 'cancelled'],
  paid: ['shipped', 'refunded'],
  shipped: ['received', 'refunded'],
  received: ['completed', 'refunded'],
  completed: ['refunded'],
  // `cancelled` and `refunded` are terminal.
});

export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  table: TransitionTable<OrderStatus> = ORDER_TRANSITIONS,
): boolean {
  return (table[from] ?? []).includes(to);
}

export interface TransitionResult {
  /** `false` means somebody else moved the order first. Never retry blindly. */
  won: boolean;
  /** Rows the conditional update changed: 0 or 1. */
  affected: number;
  /** The status actually observed when the guard failed, when cheap to read. */
  observed?: OrderStatus;
}

/**
 * Implemented by the order domain as exactly one statement:
 *
 *     UPDATE orders SET status = $to, ... WHERE id = $id AND status IN ($from)
 *
 * and the decision is `rowCount > 0`. `from` is a list because several source
 * states may legitimately lead to one target (`paid`/`shipped` -> `cancelled`
 * for an admin close-out).
 */
export interface OrderStateMachine {
  readonly table: TransitionTable<OrderStatus>;
  transition(
    tx: Tx,
    orderId: number,
    from: readonly OrderStatus[],
    to: OrderStatus,
    patch?: Record<string, unknown>,
  ): Promise<TransitionResult>;
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

export interface OrderEvent {
  orderId: number;
  orderNo: string;
  userId: number;
  /** From `ctx.clock`, so a test can pin it. */
  at: Date;
}

export interface OrderPaidEvent extends OrderEvent {
  paidAmount: Money;
  /** WeChat transaction id, when the payment came from a gateway. */
  transactionId?: string;
}

export interface OrderCancelledEvent extends OrderEvent {
  reason: 'user' | 'timeout' | 'admin' | 'payment-failed';
}

export interface OrderRefundedEvent extends OrderEvent {
  refundId: number;
  /** The 退款单号 a shopper sees; what 退款到账提醒 names (NOTIF-007). */
  refundNo?: string | undefined;
  refundedAmount: Money;
  /** A partial refund does not end the order's life. */
  partial: boolean;
}

export interface OrderCompletedEvent extends OrderEvent {
  completedBy: 'user' | 'auto' | 'admin';
}

/**
 * Runs inside the caller's transaction. Database work only — no HTTP, no
 * queue side effects other than `recordEffect`, and no throwing for anything
 * that is not a real invariant violation, because a throw rolls the whole
 * state change back.
 */
export type OrderHook<E extends OrderEvent> = (tx: Tx, ctx: Ctx, event: E) => Promise<void>;

interface HookRegistration<E extends OrderEvent> {
  /** `<domain>:<what>`, e.g. `groupbuy:close-team`. Appears in errors and logs. */
  name: string;
  handler: OrderHook<E>;
}

class HookRegistry<E extends OrderEvent> {
  private readonly hooks: HookRegistration<E>[] = [];

  constructor(private readonly label: string) {}

  /** Registering the same name twice replaces it — module reloads in dev are fine. */
  register(name: string, handler: OrderHook<E>): void {
    const at = this.hooks.findIndex((h) => h.name === name);
    if (at >= 0) this.hooks[at] = { name, handler };
    else this.hooks.push({ name, handler });
  }

  names(): string[] {
    return this.hooks.map((h) => h.name);
  }

  clear(): void {
    this.hooks.length = 0;
  }

  /**
   * Runs every hook in registration order, inside `tx`. A hook that throws
   * aborts the transaction — that is intended: if `groupbuy` cannot close the
   * team, the order must not be marked paid either.
   */
  async dispatch(tx: Tx, ctx: Ctx, event: E): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook.handler(tx, ctx, event);
      } catch (error) {
        ctx.logger.error(
          { err: error, hook: hook.name, event: this.label, orderId: event.orderId },
          'order hook failed',
        );
        throw error;
      }
    }
  }
}

/**
 * A shipment was dispatched: `shipOrder` (the console) or
 * the automatic virtual delivery. `deliveryMode` and `allDelivered` are what
 * WeChat's 发货信息管理 needs to know about the parcel, frozen at the moment of
 * dispatch so a later shipment cannot rewrite what this one was.
 */
export interface ShipmentDispatchedEvent extends OrderEvent {
  shipmentId: number;
  deliveryMode: 'express' | 'merchant_delivery' | 'virtual';
  /** This shipment put the last outstanding unit on its way (`paid -> shipped`). */
  allDelivered: boolean;
  /** The order's other shipments, cancelled ones included, oldest first. */
  otherShipments: ReadonlyArray<{ id: number; cancelled: boolean }>;
}

/** 修改发货信息: the transport details of a dispatched shipment changed. */
export interface ShipmentUpdatedEvent extends OrderEvent {
  shipmentId: number;
}

export const onOrderPaid = new HookRegistry<OrderPaidEvent>('order.paid');
export const onOrderCancelled = new HookRegistry<OrderCancelledEvent>('order.cancelled');
export const onOrderRefunded = new HookRegistry<OrderRefundedEvent>('order.refunded');
export const onOrderCompleted = new HookRegistry<OrderCompletedEvent>('order.completed');
export const onShipmentDispatched = new HookRegistry<ShipmentDispatchedEvent>(
  'shipment.dispatched',
);
export const onShipmentUpdated = new HookRegistry<ShipmentUpdatedEvent>('shipment.updated');

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface StockLine {
  skuId: number;
  quantity: number;
}

/**
 * Stock, owned by the catalog domain.
 *
 * Reserve at order creation, commit on payment, release on cancel/refund.
 * Every method is one atomic statement per line — `incStockDecSales`' read-then
 * -write is the defect being fixed here — and every method is idempotent per
 * `orderId`, because the effect ledger may call `release` twice.
 */
export interface StockReleaseOptions {
  /**
   * `commit` already ran for these lines (the order was paid), so `sales` must
   * come back down in the same statement that puts `stock` back. Absent on the
   * cancel / payment-timeout path, where `sales` never moved.
   */
  committed?: boolean;
  /**
   * The refund this release belongs to. An order can be refunded line by line,
   * so a refund release is idempotent per refund, not per order: without this
   * the second partial refund of an order would be swallowed as a replay.
   */
  refundId?: number;
}

export interface StockPort {
  /**
   * Returns the lines that could NOT be satisfied. Empty array means success.
   *
   * `ctx` is optional, and trailing, because the decrement itself needs nothing
   * from it: it is there so that the catalog can record 库存预警 for a SKU this
   * reservation pushed under its threshold, inside the caller's transaction. A
   * caller that has a context passes it; the fakes and the tests that drive the
   * port directly do not, and get no warning — which is what they want.
   */
  reserve(tx: Tx, orderId: number, lines: readonly StockLine[], ctx?: Ctx): Promise<StockLine[]>;
  release(
    tx: Tx,
    orderId: number,
    lines: readonly StockLine[],
    options?: StockReleaseOptions,
  ): Promise<void>;
  /** Turns a reservation into a sale: stock stays down, `sales` goes up. */
  commit(tx: Tx, orderId: number, lines: readonly StockLine[]): Promise<void>;
}

/**
 * Payment, owned by the payment domain.
 *
 * `ensureNoOpenAttempts` is the "payment vs cancel" lock: the cancel path asks
 * payment whether money may still arrive, and acts on the answer —
 *
 *   `closed`  no attempt can succeed any more; the cancel may proceed;
 *   `paid`    money already arrived; run the paid transition and refuse the cancel;
 *   `unknown` the gateway did not answer in time; refuse the cancel and keep
 *             every reservation, stock and coupon included. Never guess.
 *
 * It is called inside the cancelling transaction with the order row already
 * locked, so it must not perform network I/O that can hang without a timeout.
 * Being database-only it cannot resolve an attempt that is still open — it
 * answers `unknown` rather than going to find out — so cancellation is a
 * **two-call protocol**: `closeOrderPayments` first, outside the transaction,
 * where talking to WeChat costs nobody a row lock, and then
 * `ensureNoOpenAttempts` as the re-check under the lock, which is what catches
 * an attempt that opened in between.
 */
export type PaymentState = 'closed' | 'paid' | 'unknown';

export interface PaymentPort {
  ensureNoOpenAttempts(tx: Tx, orderId: number): Promise<PaymentState>;
  /** Closes every open attempt at the gateway. Call outside a transaction. */
  closeOrderPayments(ctx: Ctx, orderId: number): Promise<PaymentState>;
  /**
   * `pending_payment → paid` for an order whose payable amount is zero (a coupon
   * covered all of it): there is nothing to collect, and WeChat Pay cannot take
   * 0. Checkout calls it in the order's own transaction. Optional so the fakes
   * need not care; without it a zero-amount order waits for the cashier, whose
   * `payment.start` settles it the same way.
   */
  settleZeroAmountOrder?(tx: Tx, ctx: Ctx, orderId: number): Promise<void>;
}

/**
 * Freight, owned by the shipping domain. Called by checkout while pricing a
 * cart.
 *
 * Amounts are integer 分 so the port stays free of the `Money` class at its
 * boundary; `perLine` is aligned with the `lines` argument and must sum to
 * `totalFen`, so checkout can attribute shipping per item for a partial refund.
 */
export interface FreightLine {
  skuId: number;
  quantity: number;
  freightTemplateId: number | null;
  /**
   * How this line is charged.
   *
   * `freightTemplateId` alone cannot say: a line that ships **free** and a line
   * with a **fixed** postage both carry `null`, and they price differently —
   * free is 0, fixed is `fixedFreightFen × quantity`. Carrying the mode means
   * the port does not re-read the skus its caller has just read, once per
   * quote.
   */
  freightMode: 'free' | 'fixed' | 'template';
  /** 分 per unit. `0` unless `freightMode === 'fixed'`. */
  fixedFreightFen: number;
  /** Grams. */
  weight: number;
  /** Cubic centimetres. */
  volume: number;
  /** Line subtotal in 分, for "free over N" rules. */
  amountFen: number;
}

export interface FreightQuote {
  totalFen: number;
  /** Same length and order as the requested lines; sums to `totalFen`. */
  perLine: number[];
}

export interface FreightPort {
  /**
   * `db` is the caller's handle — checkout quotes inside its creating
   * transaction, and a port that read through `ctx.db` instead would take a
   * second pool connection per buyer and deadlock the pool under load.
   */
  quote(
    db: DbOrTx,
    ctx: Ctx,
    input: { addressCityId: number | null; lines: readonly FreightLine[] },
  ): Promise<FreightQuote>;
}

/**
 * How a marketing domain (coupon, group-buy, presale, …) adjusts a price.
 *
 * Contributors are pure: they look at the draft and return adjustments, they do
 * not write. Checkout applies them in `priority` order and splits every
 * adjustment across lines with `Money.allocate`, so the parts always sum back
 * exactly.
 */
export interface PricingLine {
  skuId: number;
  productId: number;
  quantity: number;
  unitPrice: Money;
  /** Line total before any adjustment. */
  subtotal: Money;
}

export interface PricingDraft {
  userId: number;
  lines: readonly PricingLine[];
  /** Sum of the line subtotals. */
  goodsTotal: Money;
  /** Caller-supplied selections, e.g. `{ couponId: '3' }`. */
  selections: Readonly<Record<string, string | undefined>>;
  /**
   * What the pricing pass took off, by contributor. Empty on the pricing pass
   * itself (a contributor cannot see its peers); populated for `beforeCreate`,
   * so a kind handler can verify its own adjustment landed.
   */
  adjustments?: readonly PriceAdjustment[];
}

export interface PriceAdjustment {
  /** `<domain>:<rule>`, e.g. `coupon:full-reduction`. Shown to the user. */
  source: string;
  label: string;
  /** Negative for a discount. Always applied to the goods total. */
  amount: Money;
  /** Per-line split; when omitted checkout allocates by line subtotal. */
  perLine?: readonly Money[];
  /** Opaque data the contributor needs again at order-creation time. */
  meta?: Record<string, unknown>;
}

export interface PricingContributor {
  name: string;
  /** Lower runs first. Coupons are 100; member-style rules would be lower. */
  priority: number;
  contribute(ctx: Ctx, draft: PricingDraft): Promise<PriceAdjustment[]>;
}

/**
 * Group-buy and presale attach here instead of forking the order service.
 * `kind` is stored on the order and selects the handler again on every later
 * transition.
 */
export interface OrderKindHandler {
  kind: string;
  /** Vetoes or annotates creation; throws a `DomainError` to refuse. */
  beforeCreate(ctx: Ctx, tx: Tx, draft: PricingDraft): Promise<Record<string, unknown>>;
  /** Extra state the kind keeps alongside the order (a team seat, a deposit). */
  afterCreate(ctx: Ctx, tx: Tx, orderId: number, meta: Record<string, unknown>): Promise<void>;
  /** May refuse a transition the base machine would allow. */
  canTransition?(from: OrderStatus, to: OrderStatus): boolean;
  /**
   * Read-only: what the shopper's 订单详情 links to for this kind (the 拼团 team). Optional —
   * a kind without it adds nothing. Never writes, never throws for a missing row.
   */
  detailLinks?(db: DbOrTx, orderId: number): Promise<OrderKindDetailLinks>;
  /**
   * Read-only, batched: where each of these orders stands in its kind's own state (the 拼团
   * team and the order's seat in it), for 我的订单 and 订单详情. Optional; an order the kind
   * has nothing for is simply absent from the map.
   */
  orderStates?(db: DbOrTx, orderIds: readonly number[]): Promise<Map<number, OrderKindState>>;
  /**
   * Read-only, inside the dispatch transaction: whether this order may ship yet. A 拼团 order
   * waits for its team to succeed (RISK-D-011) — shipping to a team that then fails would
   * refund goods already on the road. Optional; a kind without it ships once paid.
   */
  readyToShip?(db: DbOrTx, orderId: number): Promise<boolean>;
  /**
   * Read-only, for 确认订单: what this kind promises before the order exists (the presale
   * ship time). Optional — a kind without it adds nothing. `selections` are the checkout
   * body's `kindMeta`, unvalidated: answer nothing for an activity it cannot find rather
   * than throw — the refusal is `beforeCreate`'s, and the pricing pass already made it.
   */
  previewTerms?(
    db: DbOrTx,
    selections: Readonly<Record<string, string | undefined>>,
  ): Promise<OrderKindPreviewTerms>;
  /**
   * Read-only: the shipping template this kind's order is charged by instead of each
   * product's own freight setting (an activity's 运费模板), or `null` to follow the
   * products. Optional, and read on every pricing pass — preview and create alike —
   * so the two cannot disagree. Same rule as `previewTerms` for an activity it
   * cannot find: `null`, not a throw.
   */
  freightTemplateId?(
    db: DbOrTx,
    selections: Readonly<Record<string, string | undefined>>,
  ): Promise<number | null>;
}

/** What `OrderKindHandler.detailLinks` answers; every key is optional. */
export interface OrderKindPreviewTerms {
  /** Days after the order is paid in full that it ships (预售: 付款后 N 天内发货). */
  shipAfterDays?: number | null;
}

export interface OrderKindDetailLinks {
  /** The `groupbuy_groups.id` the order holds its membership in. */
  groupbuyTeamId?: number | null;
}

/** What `OrderKindHandler.orderStates` answers per order; every key is optional. */
export interface OrderKindState {
  /** 拼团: the team the order holds its seat in, and that seat's role. */
  groupbuyTeam?: {
    id: number;
    status: 'forming' | 'succeeded' | 'failed' | 'cancelled';
    role: 'leader' | 'member';
    seatsTotal: number;
    seatsTaken: number;
    expiresAt: Date;
  };
}

/**
 * Order facts — the one inbound seam. Every port above is order calling out;
 * this is another domain asking the order domain a read-only question it cannot
 * answer itself (reviews, lifetime purchase limits, the delete guard). The
 * order domain registers the implementation; callers never read `orders`.
 */
export interface ReviewableLine {
  orderId: number;
  orderItemId: number;
  productId: number;
  skuId: number;
  /** Variant label frozen on the order line, so a later spec rename cannot rewrite a review. */
  specText: string;
  userId: number;
}

export interface OrderFactsPort {
  /**
   * The order line a shopper may review, or `null`. `null` covers every refusal
   * — not theirs, not received, refunded, missing — because saying which would
   * leak another shopper's order.
   */
  findReviewableLine(
    tx: Tx,
    args: { orderItemId: number; userId: number },
  ): Promise<ReviewableLine | null>;
  /** Units of the product this user has committed to (not cancelled, not refunded, unpaid included): `order.repo.purchasedQuantity`. */
  purchasedQuantity(tx: Tx, args: { userId: number; productId: number }): Promise<number>;
  /** Lines of orders completed at or before the instant that still have no review, oldest first. */
  findLinesAwaitingReview(
    tx: Tx,
    args: { completedBefore: Date; limit: number },
  ): Promise<ReviewableLine[]>;
  /** Whether any unfinished order still references the product. */
  hasOpenOrders(tx: Tx, productId: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function slot<T>(label: string) {
  let value: T | undefined;
  return {
    set(impl: T): void {
      value = impl;
    },
    get(): T {
      if (value === undefined) {
        throw new DomainError('INTERNAL', {
          message: `${label} 尚未注册（提供该端口的领域未加载）`,
        });
      }
      return value;
    },
    peek(): T | undefined {
      return value;
    },
    clear(): void {
      value = undefined;
    },
  };
}

const stockSlot = slot<StockPort>('StockPort');
const paymentSlot = slot<PaymentPort>('PaymentPort');
const freightSlot = slot<FreightPort>('FreightPort');
const stateMachineSlot = slot<OrderStateMachine>('OrderStateMachine');
const orderFactsSlot = slot<OrderFactsPort>('OrderFactsPort');

export const registerStockPort = stockSlot.set;
export const getStockPort = stockSlot.get;

export const registerPaymentPort = paymentSlot.set;
export const getPaymentPort = paymentSlot.get;

export const registerFreightPort = freightSlot.set;
export const getFreightPort = freightSlot.get;

export const registerOrderStateMachine = stateMachineSlot.set;
export const getOrderStateMachine = stateMachineSlot.get;

export const registerOrderFacts = orderFactsSlot.set;
export const getOrderFacts = orderFactsSlot.get;

const contributors: PricingContributor[] = [];

export function registerPricingContributor(contributor: PricingContributor): void {
  const at = contributors.findIndex((c) => c.name === contributor.name);
  if (at >= 0) contributors[at] = contributor;
  else contributors.push(contributor);
}

/** In `priority` order, then registration order. */
export function getPricingContributors(): readonly PricingContributor[] {
  return [...contributors].sort((a, b) => a.priority - b.priority);
}

const kindHandlers = new Map<string, OrderKindHandler>();

export function registerOrderKindHandler(handler: OrderKindHandler): void {
  kindHandlers.set(handler.kind, handler);
}

export function getOrderKindHandler(kind: string): OrderKindHandler | undefined {
  return kindHandlers.get(kind);
}

/** One batched `orderStates` read per kind on the page. */
export async function kindStatesFor(
  db: DbOrTx,
  rows: readonly { id: number; kind: string }[],
): Promise<Map<number, OrderKindState>> {
  const out = new Map<number, OrderKindState>();
  const byKind = new Map<string, number[]>();
  for (const row of rows) {
    const ids = byKind.get(row.kind);
    if (ids) ids.push(row.id);
    else byKind.set(row.kind, [row.id]);
  }
  for (const [kind, ids] of byKind) {
    const states = await getOrderKindHandler(kind)?.orderStates?.(db, ids);
    for (const [orderId, state] of states ?? []) out.set(orderId, state);
  }
  return out;
}

export function allOrderKinds(): string[] {
  return [...kindHandlers.keys()].sort();
}

/** Test helper. Never call this from app code. */
export function resetOrderPorts(): void {
  stockSlot.clear();
  paymentSlot.clear();
  freightSlot.clear();
  stateMachineSlot.clear();
  orderFactsSlot.clear();
  contributors.length = 0;
  kindHandlers.clear();
  onOrderPaid.clear();
  onOrderCancelled.clear();
  onOrderRefunded.clear();
  onOrderCompleted.clear();
  onShipmentDispatched.clear();
  onShipmentUpdated.clear();
}
