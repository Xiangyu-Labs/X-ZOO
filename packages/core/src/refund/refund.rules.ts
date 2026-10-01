import { Money } from '../kernel/money';

/**
 * What a refund is worth, and what may go into one.
 *
 * Pure functions over plain data, so the interesting arithmetic is unit-tested
 * without a database. The rule they encode is that **the service computes the
 * money and the request never carries it**: `refundApplyBody` has lines and
 * quantities and no amount, so a crafted body cannot ask for more than was
 * paid.
 */

export interface RefundableLineInput {
  orderItemId: number;
  quantity: number;
  refundedQuantity: number;
  shippedQuantity: number;
  /** `quantity * unitPrice - discountAmount`, already stored on the line. */
  totalAmount: string;
  refundedAmount: string;
  /** Inside another in-flight request. */
  isOpen: boolean;
}

export interface RefundableLine extends RefundableLineInput {
  refundableQuantity: number;
  refundableAmount: Money;
  blockedReason: string | null;
}

/**
 * How much of a line is still claimable.
 *
 * The share of one unit is the line total divided by its quantity *with the
 * remainder allocated*, never `round(total / quantity)`: three units of 10.00
 * that cost 29.99 must give back 10.00, 10.00 and 9.99, and only an allocation
 * gets the last fen right. Refunding all remaining units therefore always
 * returns exactly what is left, with no drift.
 */
export function refundableLine(line: RefundableLineInput): RefundableLine {
  const remaining = Math.max(0, line.quantity - line.refundedQuantity);
  const total = Money.parse(line.totalAmount);
  const alreadyRefunded = Money.parse(line.refundedAmount);
  const left = total.sub(alreadyRefunded).clampToZero();

  const blockedReason = line.isOpen
    ? 'REFUND_ALREADY_OPEN'
    : remaining === 0
      ? 'REFUND_LINE_INVALID'
      : null;

  return {
    ...line,
    refundableQuantity: blockedReason === null ? remaining : 0,
    refundableAmount: blockedReason === null ? left : Money.ZERO,
    blockedReason,
  };
}

/**
 * The money for `quantity` units of a line.
 *
 * Refunding *all* remaining units gives back everything that is left, so a
 * partial refund followed by the rest can never leave a stray fen behind;
 * fewer units get their allocated share of the line total.
 */
export function lineRefundAmount(line: RefundableLineInput, quantity: number): Money {
  const total = Money.parse(line.totalAmount);
  const alreadyRefunded = Money.parse(line.refundedAmount);
  const remainingUnits = line.quantity - line.refundedQuantity;
  const remainingMoney = total.sub(alreadyRefunded).clampToZero();

  if (quantity >= remainingUnits) return remainingMoney;

  const shares = total.allocate(new Array<number>(line.quantity).fill(1));
  let sum = Money.ZERO;
  for (let i = 0; i < quantity; i += 1) sum = sum.add(shares[i] ?? Money.ZERO);
  // Never promise more than is actually left on the line.
  return sum.lte(remainingMoney) ? sum : remainingMoney;
}

/**
 * Freight comes back only while nothing has shipped.
 *
 * Once a parcel is moving the carrier has been paid, so the shop is out of
 * pocket for it. Refunding freight on any full refund is where "why did we pay
 * the shipping twice" reports come from.
 */
export function freightRefundable(fulfillmentStatus: string): boolean {
  return fulfillmentStatus === 'unfulfilled';
}

export interface CeilingInput {
  paidAmount: string | null;
  refundedAmount: string;
  /** Already committed to other in-flight requests. */
  openAmount: string;
}

/** What a new request may still ask for. Never negative. */
export function remainingCeiling(input: CeilingInput): Money {
  const paid = input.paidAmount === null ? Money.ZERO : Money.parse(input.paidAmount);
  const spoken = Money.parse(input.refundedAmount).add(Money.parse(normalise(input.openAmount)));
  return paid.sub(spoken).clampToZero();
}

/** PostgreSQL prints `sum(numeric)` without trailing zeros; `Money.parse` wants a decimal. */
export function normalise(value: string): string {
  return value.includes('.') ? value : `${value}.00`;
}

/**
 * Units of an order, for the roll-up of an order that collected nothing.
 *
 * `settled` counts the units of refunds that reached `succeeded` — not
 * `refunded_quantity`, which also holds units an approved 仅退款 has only
 * reserved.
 */
export interface OrderUnits {
  ordered: number;
  settled: number;
}

/**
 * Which roll-up the order should carry after a refund settles.
 *
 * Money decides it for an order that collected money. An order a coupon paid
 * for in full (`paid = 0`) has no money to measure, so its units do: every
 * unit settled is `refunded`, some is `partially_refunded` (REFUND-016).
 */
export function orderRefundStatus(
  refundedAmount: Money,
  paidAmount: Money,
  hasOpen: boolean,
  units?: OrderUnits,
): 'none' | 'requested' | 'partially_refunded' | 'refunded' {
  if (paidAmount.isPositive()) {
    if (refundedAmount.gte(paidAmount)) return 'refunded';
    if (refundedAmount.isPositive()) return 'partially_refunded';
    return hasOpen ? 'requested' : 'none';
  }
  if (units !== undefined && units.ordered > 0 && units.settled >= units.ordered) {
    return 'refunded';
  }
  if (units !== undefined && units.settled > 0) return 'partially_refunded';
  return hasOpen ? 'requested' : 'none';
}

// ---------------------------------------------------------------------------
// the life of a request
// ---------------------------------------------------------------------------

type RefundKind = 'refund_only' | 'return_and_refund';
type RefundStatus =
  | 'applied'
  | 'approved'
  | 'rejected'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled';

/**
 * The statuses in which a request is still in flight: it holds its lines
 * (`refund_items.is_open`), its amount counts against the ceiling, and the
 * shopper sees it as 处理中.
 *
 * `failed` is one of them. The gateway said no, but the merchant can still
 * press 复核 and send it again under the same number, so letting the shopper
 * re-apply for the same lines — or the ceiling forget the amount — would let
 * two refunds pay out for one set of units (REFUND-017). A failed request
 * leaves this set only when the merchant closes it (拒绝) or the shopper
 * withdraws it.
 */
export const IN_FLIGHT_STATUSES = [
  'applied',
  'approved',
  'processing',
  'unknown',
  'failed',
] as const satisfies readonly RefundStatus[];

export function isInFlight(status: RefundStatus): boolean {
  return (IN_FLIGHT_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether a request's units count in `order_items.refunded_quantity` — the
 * TypeScript twin of `countedUnits` in the repo, which must say the same.
 *
 * A 仅退款 takes its units out of fulfilment from approval until it is closed
 * (so the warehouse never ships goods an operator agreed to refund, and a
 * failed one keeps them while a retry is possible); a return counts only once
 * the money is back.
 */
export function countsUnits(kind: RefundKind, status: RefundStatus): boolean {
  if (status === 'succeeded') return true;
  return (
    kind === 'refund_only' &&
    (status === 'approved' ||
      status === 'processing' ||
      status === 'unknown' ||
      status === 'failed')
  );
}

/**
 * 撤销申请, from the shopper's side: while no money can have moved
 * (`applied`, `approved`, `failed`), and never for a refund the shop opened by
 * itself — withdrawing a failed group buy's refund would leave the shopper's
 * money on an order that can never ship.
 */
export function buyerMayWithdraw(refund: { status: RefundStatus; isAutomatic: boolean }): boolean {
  if (refund.isAutomatic) return false;
  return refund.status === 'applied' || refund.status === 'approved' || refund.status === 'failed';
}

// ---------------------------------------------------------------------------
// freight
// ---------------------------------------------------------------------------

export interface FreightLine {
  /** `quantity - refunded_quantity`. */
  remaining: number;
  /** Units this request asks for. */
  asked: number;
  /** The line is inside another in-flight request, so nobody can ask for it now. */
  held: boolean;
}

/**
 * Whether a request takes everything that is still takeable — the condition,
 * besides "nothing shipped", for it to carry the freight.
 *
 * A line held by another in-flight request counts as taken: the apply screen
 * cannot offer it, and the shopper's second request on an unshipped order is
 * the rest of the order (REFUND-018). The client's `includesFreight` makes the
 * same decision from the same data.
 */
export function coversEverything(lines: readonly FreightLine[]): boolean {
  return lines.every((line) => line.remaining <= 0 || line.held || line.asked >= line.remaining);
}

// ---------------------------------------------------------------------------
// what the shopper reads
// ---------------------------------------------------------------------------

export interface LogLineInput {
  fromStatus: RefundStatus | null;
  toStatus: RefundStatus;
  message: string | null;
  operatorAdminId: number | null;
  operatorUserId: number | null;
}

/**
 * The shopper's timeline entry for one log row, or `null` to leave it out.
 *
 * What the shopper or an operator wrote is theirs to read (the buyer's own
 * lines, 商家同意退款：备注, 商家拒绝：原因). What the system wrote is replaced by a
 * fixed line per status, so a gateway status, a source tag or a merchant
 * number — whatever an older row carries — never reaches the shopper
 * (REFUND-019). A system row that does not move the status is staff detail and
 * is left out.
 */
export function shopperLogMessage(
  log: LogLineInput,
  refund: { amount: string; reason: string | null },
): string | null {
  if (log.operatorAdminId !== null || log.operatorUserId !== null) return log.message;
  if (log.fromStatus === log.toStatus) return null;
  switch (log.toStatus) {
    case 'approved':
      return refund.reason ?? '已同意退款';
    case 'processing':
    case 'unknown':
      return '退款处理中';
    case 'failed':
      return '退款未完成，商家处理中';
    case 'succeeded':
      return Money.parse(refund.amount).isZero() ? '售后已完成' : '退款成功，款项已原路退回';
    case 'rejected':
      return '售后已关闭';
    case 'cancelled':
      return '售后已撤销';
    case 'applied':
      return '提交申请';
  }
}
