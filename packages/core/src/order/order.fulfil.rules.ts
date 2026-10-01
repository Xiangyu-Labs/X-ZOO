import { Money } from '../kernel/money';
import { distribute, payableOf } from './order.pricing';

/**
 * Everything about fulfilment that can be decided without a database.
 *
 * Keeping it here buys two things: the integration tests get to be about
 * *state* rather than arithmetic, and the fiddly cases — a line that is half
 * shipped and half refunded, a repricing that must not push a line below zero —
 * are covered by a plain unit test that runs in milliseconds.
 */

export type ProductKind = 'physical' | 'virtual_card' | 'virtual_coupon' | 'virtual_manual';

export interface LineState {
  orderItemId: number;
  quantity: number;
  shippedQuantity: number;
  refundedQuantity: number;
  productKind: string;
}

/** Units of a line that still have to go out: ordered, minus shipped, minus refunded. */
export function outstandingOf(line: LineState): number {
  return Math.max(0, line.quantity - line.shippedQuantity - line.refundedQuantity);
}

/**
 * Which lines a human may ship.
 *
 * `virtual_card` and `virtual_coupon` are excluded: the paid hook delivered
 * them and their `shipped_quantity` is already at the line total, so they never
 * appear as outstanding anyway — but saying it explicitly is what lets the
 * service answer `ORDER_VIRTUAL_AUTO_DELIVERED` instead of a puzzling
 * "nothing to ship".
 */
export function isManuallyShippable(kind: string): boolean {
  return kind === 'physical' || kind === 'virtual_manual';
}

export type ShipPlanOutcome =
  | { kind: 'ok'; lines: { orderItemId: number; quantity: number }[] }
  | { kind: 'nothing-outstanding' }
  | { kind: 'auto-delivered-only' }
  | { kind: 'unknown-lines'; orderItemIds: number[] }
  | { kind: 'over-ship'; orderItemId: number; requested: number; remaining: number };

/**
 * Turns "ship these lines" — or the 一键发货 empty list — into the exact
 * per-line quantities to write.
 *
 * This is a *plan*, not a decision: every quantity it produces is still written
 * through `bumpShippedQuantity`, whose WHERE clause re-checks the same bound
 * against the committed row. The plan exists to give the operator a precise
 * error message, not to make the write safe.
 */
export function planShipment(
  lines: readonly LineState[],
  requested: readonly { orderItemId: number; quantity: number }[],
): ShipPlanOutcome {
  const byId = new Map(lines.map((line) => [line.orderItemId, line]));

  if (requested.length === 0) {
    const shippable = lines.filter((line) => isManuallyShippable(line.productKind));
    const plan = shippable
      .map((line) => ({ orderItemId: line.orderItemId, quantity: outstandingOf(line) }))
      .filter((line) => line.quantity > 0);
    if (plan.length > 0) return { kind: 'ok', lines: plan };
    // Nothing left to ship by hand. If the only lines with anything outstanding
    // are card/coupon lines, say so precisely.
    const autoOutstanding = lines.some(
      (line) => !isManuallyShippable(line.productKind) && outstandingOf(line) > 0,
    );
    return autoOutstanding ? { kind: 'auto-delivered-only' } : { kind: 'nothing-outstanding' };
  }

  const unknown = requested
    .filter((line) => !byId.has(line.orderItemId))
    .map((line) => line.orderItemId);
  if (unknown.length > 0) return { kind: 'unknown-lines', orderItemIds: unknown };

  // Two rows for the same line in one body are added together rather than
  // silently overwriting each other.
  const merged = new Map<number, number>();
  for (const line of requested) {
    merged.set(line.orderItemId, (merged.get(line.orderItemId) ?? 0) + line.quantity);
  }

  const plan: { orderItemId: number; quantity: number }[] = [];
  for (const [orderItemId, quantity] of merged) {
    const line = byId.get(orderItemId)!;
    if (!isManuallyShippable(line.productKind)) return { kind: 'auto-delivered-only' };
    const remaining = outstandingOf(line);
    if (quantity > remaining)
      return { kind: 'over-ship', orderItemId, requested: quantity, remaining };
    if (quantity > 0) plan.push({ orderItemId, quantity });
  }
  return plan.length > 0 ? { kind: 'ok', lines: plan } : { kind: 'nothing-outstanding' };
}

export type FulfillmentStatus = 'unfulfilled' | 'partially_fulfilled' | 'fulfilled';

/**
 * The roll-up, from the line states as they will be after this dispatch.
 *
 * A refunded unit counts as settled, not as outstanding: an order whose only
 * unshipped unit was refunded is `fulfilled`, because nothing is ever going to
 * be sent for it. Counting it as outstanding would leave such an order stuck in
 * 部分发货 forever, and 待发货 would never empty.
 */
export function rollUpFulfillment(lines: readonly LineState[]): FulfillmentStatus {
  if (lines.length === 0) return 'unfulfilled';
  const anyShipped = lines.some((line) => line.shippedQuantity > 0);
  const allSettled = lines.every((line) => outstandingOf(line) === 0);
  if (allSettled) return 'fulfilled';
  return anyShipped ? 'partially_fulfilled' : 'unfulfilled';
}

/** The line states a plan would produce, without touching the database. */
export function applyPlan(
  lines: readonly LineState[],
  plan: readonly { orderItemId: number; quantity: number }[],
): LineState[] {
  const added = new Map(plan.map((line) => [line.orderItemId, line.quantity]));
  return lines.map((line) => ({
    ...line,
    shippedQuantity: line.shippedQuantity + (added.get(line.orderItemId) ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// repricing
// ---------------------------------------------------------------------------

export interface RepriceLine {
  orderItemId: number;
  quantity: number;
  unitPrice: Money;
  /**
   * What checkout's own rules (the coupon, an activity price) took off this line — its share
   * of `orders.coupon_discount` without any earlier 改价. It stays on this line: a coupon
   * scoped to one product never moves onto another.
   */
  checkoutDiscount: Money;
}

export interface RepriceInput {
  lines: readonly RepriceLine[];
  freightAmount: Money;
  /** What the operator wants taken off on top. */
  operatorDiscount: Money;
}

export type RepriceOutcome =
  | {
      kind: 'ok';
      couponDiscount: Money;
      freightAmount: Money;
      payableAmount: Money;
      lines: { orderItemId: number; discountAmount: Money; totalAmount: Money }[];
    }
  | { kind: 'too-large'; maximum: Money };

/**
 * 改价, as arithmetic.
 *
 * The operator names a discount; each line keeps what checkout took off it and
 * only the operator's discount is spread, over what the lines still cost, with
 * checkout's own `distribute`. The new `orders.coupon_discount` is the checkout
 * discount plus the operator's, and `payableAmount` comes from checkout's own
 * `payableOf`. Nothing here invents a number.
 *
 * Three properties, all asserted in `order.fulfil.rules.test.ts`:
 *
 *  1. the per-line shares still sum back to `couponDiscount` exactly, so a
 *     later partial refund reads the line and is right;
 *  2. a line's checkout share never moves (ORDER-012): re-spreading a coupon
 *     that applied to one product across every line would refund the wrong
 *     amount when a line comes back;
 *  3. no line is discounted below zero — `distribute` clamps to each line's
 *     remaining total and pushes the excess onto lines with room, and a
 *     discount larger than the goods left is refused rather than clamped,
 *     because an operator who typed 1000 instead of 10 should be told.
 */
export function reprice(input: RepriceInput): RepriceOutcome {
  const subtotals = input.lines.map((line) => line.unitPrice.mul(line.quantity));
  const goodsTotal = Money.sum(subtotals);
  const checkoutDiscount = Money.sum(input.lines.map((line) => line.checkoutDiscount));
  const rooms = input.lines.map((line, index) =>
    subtotals[index]!.sub(line.checkoutDiscount).clampToZero(),
  );
  const room = Money.sum(rooms);
  if (input.operatorDiscount.gt(room)) {
    return { kind: 'too-large', maximum: room };
  }
  const target = checkoutDiscount.add(input.operatorDiscount);

  const operatorShares = distribute(input.operatorDiscount, rooms);
  const lines = input.lines.map((line, index) => {
    const share = line.checkoutDiscount.add(operatorShares[index] ?? Money.ZERO);
    return {
      orderItemId: line.orderItemId,
      discountAmount: share,
      totalAmount: subtotals[index]!.sub(share),
    };
  });

  return {
    kind: 'ok',
    couponDiscount: target,
    freightAmount: input.freightAmount,
    payableAmount: payableOf(goodsTotal, input.freightAmount, target),
    lines,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 quoting, and the one thing beyond it that matters: a cell starting
 * with `=`, `+`, `-` or `@` is prefixed with a single quote.
 *
 * That is CSV injection — a buyer whose 收货人 is `=cmd|'/c calc'!A1` gets it
 * executed when an operator opens the export in Excel. Writing cells straight
 * through, as most spreadsheet libraries do by default, leaves that hole open.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return `${cells.map(csvCell).join(',')}\n`;
}

export function csvDocument(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return csvRow(header) + rows.map(csvRow).join('');
}
