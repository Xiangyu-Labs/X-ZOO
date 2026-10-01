import { DomainError } from '../kernel/errors';
import { Money } from '../kernel/money';

/**
 * The presale decisions that need no database.
 *
 * Pure functions of values already read, so they are unit tested without
 * PostgreSQL and the integration tests can spend their time on the things that
 * genuinely race: the activity's own stock counter and the four ledgers a
 * cancel or a refund has to put back.
 *
 * The rule that is deliberately *not* here is "may this shopper take the last
 * unit". That one cannot be a pure function — it is a conditional `UPDATE` in
 * the repo, and writing it as a check (a `SELECT stock`, a comparison, then a
 * decrement) would be a read-then-write race.
 */

export interface ActivityWindow {
  status: 'draft' | 'active' | 'paused' | 'ended';
  startAt: Date;
  endAt: Date;
  deletedAt?: Date | null;
}

/** Live for a shopper: published, not deleted, and inside its sale window. */
export function isActivityOpen(activity: ActivityWindow, now: Date): boolean {
  if (activity.deletedAt) return false;
  if (activity.status !== 'active') return false;
  return activity.startAt.getTime() <= now.getTime() && activity.endAt.getTime() > now.getTime();
}

export function assertActivityOpen(activity: ActivityWindow, now: Date): void {
  if (isActivityOpen(activity, now)) return;
  throw new DomainError('PRESALE_ACTIVITY_NOT_OPEN', {
    details: {
      status: activity.status,
      startAt: activity.startAt.toISOString(),
      endAt: activity.endAt.toISOString(),
      now: now.toISOString(),
    },
  });
}

/**
 * Full payment only.
 *
 * The deposit columns exist in the schema, but nothing drives them. Refusing
 * loudly here is what stops a half-built deposit flow shipping by accident.
 */
export function assertFullPayment(activity: { paymentMode: 'full' | 'deposit' }): void {
  if (activity.paymentMode === 'full') return;
  throw new DomainError('PRESALE_DEPOSIT_NOT_SUPPORTED', {
    details: { paymentMode: activity.paymentMode },
  });
}

export interface PricedLine {
  skuId: number;
  quantity: number;
}

/**
 * 每单限购份数, plus the shape of a presale order.
 *
 * Two rules in one function because they are one question — "is this a presale
 * order this campaign will accept":
 *
 *  - **exactly one line.** `presale_stock_ledger_order_reason_uq` is
 *    `UNIQUE (order_id, reason)`, so an order has at most one reservation row
 *    and one release row; a two-line order could not record what it took. That
 *    is not a limitation being worked around, it is the schema saying how a
 *    presale item is bought: through 立即购买 only, never from a mixed cart.
 *  - **quantity within `perOrderQuantity`**, checked once, here, so the ceiling
 *    cannot be `>` in one place and `>=` in another.
 */
export function assertOrderShape(
  activity: { perOrderQuantity: number },
  lines: readonly PricedLine[],
): void {
  if (lines.length !== 1) {
    throw new DomainError('PRESALE_QUANTITY_NOT_ALLOWED', {
      details: { lines: lines.length, reason: 'one-line-only' },
    });
  }
  const quantity = lines[0]!.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > activity.perOrderQuantity) {
    throw new DomainError('PRESALE_QUANTITY_NOT_ALLOWED', {
      details: { quantity, perOrderQuantity: activity.perOrderQuantity },
    });
  }
}

/**
 * What the goods on a presale order *should* cost: the activity's per-SKU price
 * times the quantity.
 *
 * `prices` is the activity's SKU table; a line whose SKU is not in it is not
 * part of the campaign and is refused before any arithmetic happens.
 */
export function expectedGoodsTotal(
  lines: readonly PricedLine[],
  prices: ReadonlyMap<number, string>,
): Money {
  let total = Money.ZERO;
  for (const line of lines) {
    const price = prices.get(line.skuId);
    if (price === undefined) {
      throw new DomainError('PRESALE_SKU_NOT_IN_ACTIVITY', { details: { skuId: line.skuId } });
    }
    total = total.add(Money.parse(price).mul(line.quantity));
  }
  return total;
}

/**
 * The fail-closed half of the campaign-price guard.
 *
 * `buildDraft` hands `kind` and `kindMeta` to the pricing contributors and the
 * presale price reaches the shopper as a named adjustment. This guard is what
 * keeps that true: the kind handler compares the discount the campaign owes
 * against the discount the registered contributor actually produces for that
 * draft, and refuses the order when they differ.
 *
 * The failure it exists for is silent by nature — a contributor that stops
 * being registered bills the shopper the catalogue price for a presale, with
 * no error anywhere. Refusing the order is the only safe answer.
 */
export function assertActivityPriceApplied(args: {
  expected: Money;
  actual: Money;
  activityId: number;
}): void {
  if (args.expected.eq(args.actual)) return;
  throw new DomainError('PRESALE_PRICE_NOT_APPLIED', {
    details: {
      activityId: String(args.activityId),
      expected: args.expected.toString(),
      actual: args.actual.toString(),
    },
  });
}

/**
 * 预售发货：付款后 N 天内发货.
 *
 * The promise is made when the money arrives, not when the order is placed, so
 * an order that sat unpaid for a week does not ship a week early. Frozen onto
 * `presale_orders.ship_not_before_at` rather than recomputed, because the
 * operator may shorten `shipAfterDays` later and a promise already made to a
 * shopper is not theirs to move.
 */
export function shipNotBefore(paidAt: Date, shipAfterDays: number): Date {
  return new Date(paidAt.getTime() + shipAfterDays * 86_400_000);
}

/**
 * The four counters a presale sale moves, as `presale_stock_ledger` records
 * them (REFUND-002).
 *
 * Only the two activity columns are applied by this domain; the two product
 * columns are what the catalog's `StockPort` applied in the same transaction,
 * and they are recorded so a restore is one row read rather than four
 * recomputations. `committed` says whether the reservation had already become a
 * sale — the difference between a cancel (it had not) and a refund (it had).
 */
export interface StockDeltas {
  activityStockDelta: number;
  activitySalesDelta: number;
  productStockDelta: number;
  productSalesDelta: number;
}

/**
 * What placing an order takes: stock off the shelf, nothing sold yet.
 *
 * The two `sales` columns start at zero and are amended to `+quantity` when the
 * money arrives (`repo.markLedgerCommitted`). The sale has no ledger row of its
 * own because `presale_stock_ledger_reason` has exactly two values, so the
 * reservation row carries it — otherwise a refund's `-quantity` on `sales`
 * would balance against nothing.
 */
export function reserveDeltas(quantity: number): StockDeltas {
  return {
    activityStockDelta: -quantity,
    activitySalesDelta: 0,
    productStockDelta: -quantity,
    productSalesDelta: 0,
  };
}

export function releaseDeltas(quantity: number, committed: boolean): StockDeltas {
  return {
    activityStockDelta: quantity,
    activitySalesDelta: committed ? -quantity : 0,
    productStockDelta: quantity,
    productSalesDelta: committed ? -quantity : 0,
  };
}

/**
 * A reservation and its release must cancel out exactly, on all four columns.
 *
 * This is REFUND-002 written as arithmetic; the integration tests read the two
 * ledger rows back and assert it, and the `sum` is what an operator's
 * reconciliation would compute.
 */
export function ledgerBalance(rows: readonly StockDeltas[]): StockDeltas {
  return rows.reduce<StockDeltas>(
    (sum, row) => ({
      activityStockDelta: sum.activityStockDelta + row.activityStockDelta,
      activitySalesDelta: sum.activitySalesDelta + row.activitySalesDelta,
      productStockDelta: sum.productStockDelta + row.productStockDelta,
      productSalesDelta: sum.productSalesDelta + row.productSalesDelta,
    }),
    { activityStockDelta: 0, activitySalesDelta: 0, productStockDelta: 0, productSalesDelta: 0 },
  );
}

export function isBalanced(rows: readonly StockDeltas[]): boolean {
  const sum = ledgerBalance(rows);
  return (
    sum.activityStockDelta === 0 &&
    sum.activitySalesDelta === 0 &&
    sum.productStockDelta === 0 &&
    sum.productSalesDelta === 0
  );
}

/**
 * Whether the storefront should offer the 立即预订 button.
 *
 * Advisory only: the unit is still taken by a conditional `UPDATE` at order
 * creation, and between this answer and that statement the campaign can sell
 * out — which is the race `reserveActivityStock` is built to lose safely.
 */
export function canBuy(
  activity: ActivityWindow & { stock: number; paymentMode: 'full' | 'deposit' },
  now: Date,
): boolean {
  return isActivityOpen(activity, now) && activity.stock > 0 && activity.paymentMode === 'full';
}
