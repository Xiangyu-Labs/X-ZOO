import type { Tx } from '@shop/db';
import type { Ctx } from '../kernel/context';
import { DomainError, validationFailed } from '../kernel/errors';
import { Money } from '../kernel/money';
import { recordEffect } from '../effects/index';
import {
  onOrderCancelled,
  onOrderPaid,
  onOrderRefunded,
  registerOrderKindHandler,
  registerPricingContributor,
  type OrderKindHandler,
  type PriceAdjustment,
  type PricingContributor,
  type PricingDraft,
} from '../order/ports';
import * as repo from './presale.repo';
import {
  assertActivityOpen,
  assertActivityPriceApplied,
  assertFullPayment,
  assertOrderShape,
  expectedGoodsTotal,
  releaseDeltas,
  reserveDeltas,
  shipNotBefore,
} from './presale.rules';

/**
 * Where the presale domain attaches to an order.
 *
 * There is no "buy a presale" endpoint. Buying *is* placing an order, so the
 * storefront calls the order domain's `POST /api/v1/orders` with
 * `kind: 'presale'` and `kindMeta: { activityId }`, and everything here hangs
 * off the seams in `order/ports.ts`. A second checkout path would be a second
 * copy of stock, coupons, freight and idempotency, and two copies drift apart
 * on stock.
 *
 * The rule that decides the design: **presale stock is its own counter.** A
 * campaign selling 500 units of a product that has 10 000 in the warehouse must
 * stop at 500, and the two counters move together in one transaction — the
 * catalog's `StockPort` takes the SKU's, this file takes the campaign's. Four
 * counters move on a sale and all four come back on a cancel or a refund
 * (REFUND-002, QUEUE-008), which is why every movement is written to
 * `presale_stock_ledger`: `UNIQUE (order_id, reason)` makes each direction
 * happen at most once however often the effect ledger retries.
 *
 * Deposit presale is refused, not half-built. See `presale.rules.ts`.
 */

const KIND = 'presale';

/** The contributor's name, used both to register it and to check it fired. */
const PRICING_SOURCE = 'presale:activity-price';

interface KindMeta {
  activityId: number;
  userId: number;
  skuId: number;
  quantity: number;
  goodsTotal: string;
  shipAfterDays: number;
}

function readMeta(meta: Record<string, unknown>): KindMeta {
  return meta as unknown as KindMeta;
}

function readSelection(draft: PricingDraft, key: string): number | null {
  const raw = draft.selections[key];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw validationFailed({ field: key, value: raw });
  }
  return value;
}

// ---------------------------------------------------------------------------
// the kind handler
// ---------------------------------------------------------------------------

export const presaleKindHandler: OrderKindHandler = {
  kind: KIND,

  /**
   * Everything that can refuse the order, before a row exists.
   *
   * The price check is the fail-closed half of the campaign-price guard, and
   * what it compares is worth spelling out. `draft.goodsTotal` is the
   * *pre-discount* goods total — the catalogue price times the quantity —
   * because a `PricingContributor` does not rewrite line prices, it contributes
   * an adjustment that lands in `orders.coupon_discount`. So comparing the
   * campaign total against `goodsTotal` would refuse every correctly priced
   * presale order.
   *
   * What has to be true instead is that the contributor *fired*:
   * `draft.adjustments` carries what the pricing pass actually took off, by
   * contributor, so the guard is a lookup by source and refuses unless it is
   * exactly the difference between the catalogue and the campaign. An
   * unregistered, replaced or silently-returning-nothing contributor is the one
   * failure that would bill a shopper the catalogue price for a presale, and
   * this is what catches it. A missing entry reads as `Money.ZERO`, which is
   * the right answer twice over: nothing was taken off, and a campaign that
   * discounts nothing passes because the shopper pays the same either way.
   */
  async beforeCreate(ctx: Ctx, tx: Tx, draft: PricingDraft): Promise<Record<string, unknown>> {
    const activityId = readSelection(draft, 'activityId');
    if (activityId === null) throw validationFailed({ field: 'kindMeta.activityId' });
    const now = ctx.clock.now();

    const activity = await repo.findActivity(tx, activityId);
    if (!activity) throw new DomainError('PRESALE_ACTIVITY_NOT_FOUND');
    assertFullPayment(activity);
    assertActivityOpen(activity, now);

    const lines = draft.lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity }));
    assertOrderShape(activity, lines);

    const skus = await repo.listActivitySkus(tx, [activityId]);
    const prices = new Map(skus.filter((s) => s.isEnabled).map((s) => [s.skuId, s.price]));
    const campaignTotal = expectedGoodsTotal(lines, prices);
    const mine = draft.adjustments?.find((adjustment) => adjustment.source === PRICING_SOURCE);
    assertActivityPriceApplied({
      // Negative: what the campaign owes the shopper off the catalogue price.
      expected: campaignTotal.sub(draft.goodsTotal),
      actual: mine?.amount ?? Money.ZERO,
      activityId,
    });

    const line = lines[0]!;
    const meta: KindMeta = {
      activityId,
      userId: draft.userId,
      skuId: line.skuId,
      quantity: line.quantity,
      goodsTotal: campaignTotal.toString(),
      shipAfterDays: activity.shipAfterDays,
    };
    return meta as unknown as Record<string, unknown>;
  },

  /**
   * Runs inside the order domain's transaction, right beside the catalog's SKU
   * reservation.
   *
   * Three writes, in this order and for this reason: claim the ledger row
   * first, so a replay of the whole creation cannot double-decrement; then take
   * the campaign's stock, so the failure rolls the claim back with it; then
   * record the presale order itself.
   */
  async afterCreate(ctx: Ctx, tx: Tx, orderId: number, rawMeta: Record<string, unknown>) {
    const meta = readMeta(rawMeta);
    const now = ctx.clock.now();

    const activitySku = await repo.findActivitySku(tx, {
      activityId: meta.activityId,
      skuId: meta.skuId,
    });
    if (!activitySku) {
      throw new DomainError('PRESALE_SKU_NOT_IN_ACTIVITY', {
        details: { skuId: String(meta.skuId) },
      });
    }

    const claimed = await repo.claimStockLedger(tx, 'reserve', {
      activityId: meta.activityId,
      activitySkuId: activitySku.id,
      skuId: meta.skuId,
      orderId,
      quantity: meta.quantity,
      ...reserveDeltas(meta.quantity),
    });
    // Already reserved for this order: a retried creation, not a second sale.
    if (!claimed) return;

    const reserved = await repo.reserveActivityStock(tx, {
      activityId: meta.activityId,
      skuId: meta.skuId,
      quantity: meta.quantity,
    });
    if (!reserved) {
      throw new DomainError('PRESALE_OUT_OF_STOCK', { details: { skuId: String(meta.skuId) } });
    }

    await repo.insertPresaleOrder(tx, {
      orderId,
      activityId: meta.activityId,
      // Snapshot: the activity may be re-configured after the order was placed,
      // and what the shopper agreed to is what the order has to keep saying.
      paymentMode: 'full',
      // Full payment has one payment, so the order starts on the final stage.
      // `final_due_at` stays null: the deadline for *this* payment is the
      // order's own expiry and the order domain owns it — a second countdown
      // would be a second answer to the same question.
      stage: 'final_pending',
      depositAmount: null,
      finalAmount: meta.goodsTotal,
      createdAt: now,
      updatedAt: now,
    });
  },

  /**
   * 确认订单's 发货时间: the activity's `shipAfterDays` as it stands. The promise itself is
   * made at payment (`handlePaid` stamps `ship_not_before_at` from the same column), so
   * this is what the shopper gets unless the operator edits the campaign in between.
   */
  async previewTerms(db, selections) {
    const activityId = Number(selections['activityId']);
    if (!Number.isInteger(activityId) || activityId <= 0) return {};
    const activity = await repo.findActivity(db, activityId);
    return activity ? { shipAfterDays: activity.shipAfterDays } : {};
  },

  /**
   * The activity's own 运费模板, which charges the order in place of the
   * product's freight setting; `null` (the form's 留空) follows the product.
   */
  async freightTemplateId(db, selections) {
    const activityId = Number(selections['activityId']);
    if (!Number.isInteger(activityId) || activityId <= 0) return null;
    return (await repo.findActivity(db, activityId))?.shippingTemplateId ?? null;
  },
};

// ---------------------------------------------------------------------------
// the pricing contributor
// ---------------------------------------------------------------------------

/**
 * Takes the difference between the catalogue price and the presale price off
 * the goods.
 *
 * Priority 50 — before coupons (100), because a coupon's 满减 threshold should
 * be judged against what the shopper actually pays.
 *
 * It does not rewrite line prices, because no contributor does: the reduction
 * lands in `orders.coupon_discount` alongside the coupon's, and
 * `order_items.discount_amount` carries each line's share. That is why
 * `beforeCreate` checks this contributor's output rather than the draft's goods
 * total.
 *
 * It never throws. It also runs on the preview a shopper is merely looking at,
 * and a line outside the campaign simply keeps its ordinary price — refusing
 * the order is `beforeCreate`'s job.
 */
export const presalePricingContributor: PricingContributor = {
  name: PRICING_SOURCE,
  priority: 50,

  async contribute(ctx: Ctx, draft: PricingDraft): Promise<PriceAdjustment[]> {
    if (draft.selections['kind'] !== KIND) return [];
    const raw = draft.selections['activityId'];
    if (!raw) return [];
    const activityId = Number(raw);
    if (!Number.isInteger(activityId) || activityId <= 0) return [];

    const activity = await repo.findActivity(ctx.db, activityId);
    if (!activity || activity.paymentMode !== 'full') return [];
    const now = ctx.clock.now();
    if (
      activity.status !== 'active' ||
      activity.deletedAt !== null ||
      activity.startAt.getTime() > now.getTime() ||
      activity.endAt.getTime() <= now.getTime()
    ) {
      return [];
    }

    const skus = await repo.listActivitySkus(ctx.db, [activityId]);
    const prices = new Map(skus.filter((s) => s.isEnabled).map((s) => [s.skuId, s.price]));

    const perLine: Money[] = [];
    for (const line of draft.lines) {
      const price = prices.get(line.skuId);
      // A line outside the campaign keeps its ordinary price. `beforeCreate` is
      // the one that refuses the order; a contributor never throws, because it
      // also runs on the preview a shopper is merely looking at.
      if (price === undefined) {
        perLine.push(Money.ZERO);
        continue;
      }
      perLine.push(Money.parse(price).mul(line.quantity).sub(line.subtotal));
    }

    const amount = Money.sum(perLine);
    if (amount.isZero()) return [];
    return [
      {
        source: PRICING_SOURCE,
        label: `预售价（${activity.title}）`,
        amount,
        perLine,
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * The money arrived.
 *
 * Three things move and they move together: the campaign's reservation becomes
 * a sale (mirroring what the catalog's `StockPort.commit` just did on the
 * SKU's), the stage advances to `final_paid`, and the 发货承诺 is frozen onto
 * the row.
 *
 * The stage move is the idempotency guard — `from: ['final_pending']` — so a
 * replayed payment callback commits the sale exactly once. Without it a WeChat
 * retry would add the quantity to `sales` twice, and 预售销量 would drift past
 * what was actually sold.
 *
 * The sale can still be **refused**, and that is not an error either. 限购总量
 * is a ceiling on units sold and `sales` only moves here, so a quota that
 * filled while this payment was in flight loses `commitActivitySales`
 * (STOCK-004). The shopper's money has already arrived, so the answer is to
 * give the units back and ask for a refund, exactly as group buy does when a
 * seat is lost.
 */
async function handlePaid(tx: Tx, ctx: Ctx, event: { orderId: number; at: Date }): Promise<void> {
  const presale = await repo.findPresaleOrder(tx, event.orderId);
  if (!presale) return;

  const [reservation] = await repo.listStockLedger(tx, event.orderId);
  const activity = await repo.findActivityRow(tx, presale.activityId);

  const moved = await repo.setStage(tx, {
    orderId: event.orderId,
    from: ['final_pending'],
    to: 'final_paid',
    now: event.at,
    patch: {
      finalPaidAt: event.at,
      shipNotBeforeAt: shipNotBefore(event.at, activity?.shipAfterDays ?? 0),
    },
  });
  if (!moved.won) return;

  if (reservation && reservation.reason === 'reserve') {
    const sold = await repo.commitActivitySales(tx, {
      activityId: reservation.activityId,
      skuId: reservation.skuId,
      quantity: reservation.quantity,
    });
    if (!sold) {
      // 限购总量 filled while this payment was in flight (STOCK-004). The money
      // is already ours, so the order is not rolled back: the campaign's units
      // go back, the stage becomes `cancelled`, and a `presale.refund` effect
      // asks for the money back after commit.
      await repo.setStage(tx, {
        orderId: event.orderId,
        from: ['final_paid'],
        to: 'cancelled',
        now: event.at,
      });
      await releaseStock(tx, ctx, { orderId: event.orderId, at: event.at, committed: false });
      await requestAutoRefund(tx, ctx, {
        orderId: event.orderId,
        activityId: presale.activityId,
        reason: 'quota_reached',
      });
      return;
    }
    // And say so on the reservation row. The sale has no ledger row of its own
    // — the reason enum has two values — so without this the release's
    // `-quantity` on `sales` would balance against nothing and REFUND-002 would
    // read as a deficit.
    await repo.markLedgerCommitted(tx, {
      orderId: event.orderId,
      quantity: reservation.quantity,
    });
  }

  await recordEffect(tx, ctx, {
    scope: 'order',
    scopeId: String(event.orderId),
    eventType: 'presale.paid',
    payload: {
      orderId: String(event.orderId),
      activityId: String(presale.activityId),
      shipAfterDays: String(activity?.shipAfterDays ?? 0),
    },
  });
}

/**
 * The order died before it was paid. Nothing was sold, so only the reservation
 * comes back: stock up, `sales` untouched.
 *
 * **Cancel racing pay.** Both hooks move the same `presale_orders.stage` with a
 * conditional update out of `final_pending`, so exactly one of them wins and
 * the loser changes no rows and returns. Whichever way it falls the four
 * ledgers balance: pay first means the sale stands and nothing is released;
 * cancel first means the reservation is given back and `sales` never moved.
 * There is no third outcome, and no read-then-write anywhere in either path —
 * which is the whole reason the stage is a column and not a derived value.
 */
async function handleCancelled(
  tx: Tx,
  ctx: Ctx,
  event: { orderId: number; at: Date },
): Promise<void> {
  const presale = await repo.findPresaleOrder(tx, event.orderId);
  if (!presale) return;

  const moved = await repo.setStage(tx, {
    orderId: event.orderId,
    from: ['final_pending'],
    to: 'cancelled',
    now: event.at,
  });
  if (!moved.won) return;

  await releaseStock(tx, ctx, { orderId: event.orderId, at: event.at, committed: false });
}

/**
 * A full refund. A partial one changes nothing here: the shopper still holds
 * the presale, they just got some money back for part of it.
 *
 * The reservation had already become a sale, so `sales` comes back down with
 * the stock — that is the `committed: true` branch, and it is the difference
 * between this path and the cancel path.
 */
async function handleRefunded(
  tx: Tx,
  ctx: Ctx,
  event: { orderId: number; at: Date; partial: boolean },
): Promise<void> {
  if (event.partial) return;
  const presale = await repo.findPresaleOrder(tx, event.orderId);
  if (!presale) return;

  const committed = presale.stage === 'final_paid';
  await repo.setStage(tx, {
    orderId: event.orderId,
    from: ['final_pending', 'final_paid'],
    to: 'cancelled',
    now: event.at,
  });
  await releaseStock(tx, ctx, { orderId: event.orderId, at: event.at, committed });
}

/**
 * Puts the campaign's counters back, exactly once.
 *
 * The release ledger row is claimed first: `UNIQUE (order_id, 'release')` means
 * the second caller — a retried effect, a refund racing a cancel — gets `null`
 * and does nothing. The row it writes carries all four deltas, so an operator
 * reconciling the campaign reads two rows rather than replaying a history.
 */
async function releaseStock(
  tx: Tx,
  ctx: Ctx,
  args: { orderId: number; at: Date; committed: boolean },
): Promise<void> {
  const rows = await repo.listStockLedger(tx, args.orderId);
  const reservation = rows.find((row) => row.reason === 'reserve');
  if (!reservation) return;

  const claimed = await repo.claimStockLedger(tx, 'release', {
    activityId: reservation.activityId,
    activitySkuId: reservation.activitySkuId,
    skuId: reservation.skuId,
    orderId: args.orderId,
    quantity: reservation.quantity,
    ...releaseDeltas(reservation.quantity, args.committed),
  });
  if (!claimed) return;

  await repo.releaseActivityStock(tx, {
    activityId: reservation.activityId,
    skuId: reservation.skuId,
    quantity: reservation.quantity,
    soldToo: args.committed,
  });

  await recordEffect(tx, ctx, {
    scope: 'order',
    scopeId: String(args.orderId),
    eventType: 'presale.released',
    payload: {
      orderId: String(args.orderId),
      activityId: String(reservation.activityId),
      quantity: String(reservation.quantity),
      committed: String(args.committed),
    },
  });
}

/**
 * Asks for a refund the shopper never requested.
 *
 * Recorded as an effect rather than called directly, so the gateway call
 * happens after commit. `UNIQUE (scope, scope_id, event_type)` makes it
 * exactly-once however many payment callbacks arrive, and a handler that keeps
 * failing parks the row in the payment domain's 待处理任务 console for a human.
 */
async function requestAutoRefund(
  tx: Tx,
  ctx: Ctx,
  args: { orderId: number; activityId: number; reason: 'quota_reached' },
): Promise<void> {
  await recordEffect(tx, ctx, {
    scope: 'order',
    scopeId: String(args.orderId),
    eventType: 'presale.refund',
    payload: {
      orderId: String(args.orderId),
      activityId: String(args.activityId),
      reason: args.reason,
    },
  });
}

/**
 * Wires the seams. Idempotent: every registry replaces by name, so calling it
 * twice (a job module and the web bootstrap in the same process) is free, and
 * `resetOrderPorts()` in a test puts it back.
 */
export function registerPresaleOrderSeams(): void {
  registerOrderKindHandler(presaleKindHandler);
  registerPricingContributor(presalePricingContributor);
  onOrderPaid.register('presale:commit-sale', (tx, ctx, event) => handlePaid(tx, ctx, event));
  onOrderCancelled.register('presale:release-stock', (tx, ctx, event) =>
    handleCancelled(tx, ctx, event),
  );
  onOrderRefunded.register('presale:restore-ledgers', (tx, ctx, event) =>
    handleRefunded(tx, ctx, event),
  );
}
