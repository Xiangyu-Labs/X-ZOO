import { Money } from '../kernel/money';
import type { FreightLine, PriceAdjustment, PricingLine } from './ports';
import type { SkuForSale } from './catalog.port';

/**
 * Pricing, as pure functions.
 *
 * Nothing here reads a database, a clock or a port. The checkout service
 * gathers the facts — variants, contributors, the coupon quote, a freight
 * quote — and this file turns them into numbers, which is why the whole
 * pipeline is covered by a plain unit test with no container.
 *
 * Two properties are the point, and both are asserted in `order.pricing.test.ts`:
 *
 *  1. **Discount shares sum back exactly.** Every adjustment is split across
 *     the lines with `Money.allocate` (largest remainder), so
 *     `sum(order_items.discount_amount) === orders.coupon_discount` to the fen.
 *     A later partial refund therefore never has to re-prorate, and
 *     re-prorating after the fact is where refund arithmetic goes wrong.
 *  2. **No line is ever discounted below zero.** Adjustments are applied in
 *     `priority` order against what is *left* of each line, and anything that
 *     would overshoot is moved to a line that still has room.
 *
 * `orders.coupon_discount` is the column all of this lands in. It holds every
 * goods-level discount — the coupon and each `PricingContributor` — not just
 * the coupon, despite its name. The per-line `adjustments` snapshot says which
 * rule took what.
 */

export interface DiscountSplit {
  /** Total taken off the goods. Never negative, never more than the goods total. */
  total: Money;
  /** Aligned with the input lines; sums to `total` exactly. */
  perLine: Money[];
  /** The adjustments that actually moved money, for the 优惠明细 panel. */
  applied: AppliedAdjustment[];
}

export interface AppliedAdjustment {
  source: string;
  label: string;
  /** What this rule really took off, after clamping. Negative. */
  amount: Money;
  /**
   * This rule's share of each line, aligned with the input lines. Negative (or
   * zero), and sums to `amount` exactly. Persisted per order line so the order
   * reads can say what each rule took off.
   */
  perLine: Money[];
}

/** `unitPrice * quantity`. Integer multiplication only — never a ratio. */
export function lineSubtotal(unitPrice: Money, quantity: number): Money {
  return unitPrice.mul(quantity);
}

export function goodsTotalOf(lines: readonly { subtotal: Money }[]): Money {
  return Money.sum(lines.map((line) => line.subtotal));
}

/**
 * Splits `amount` across `capacities` without exceeding any of them and
 * without losing a fen.
 *
 * `Money.allocate` alone is not enough: weighted by capacity it can still hand
 * a line one leftover fen more than that line has room for, and a
 * `discount_amount > total_amount` row trips
 * `order_items_prices_non_negative` at insert time. So the allocation is
 * clamped and the excess is pushed onto whichever lines still have slack.
 *
 * `amount` is capped at `sum(capacities)` — a coupon worth more than the cart
 * takes the cart to zero and no further.
 */
export function distribute(amount: Money, capacities: readonly Money[]): Money[] {
  if (capacities.length === 0) return [];
  const room = Money.sum(capacities);
  const take = Money.min(amount.abs(), room);
  if (take.isZero()) return capacities.map(() => Money.ZERO);

  const shares = take.allocate(capacities.map((c) => c.fen));
  let excess = 0;
  const out = shares.map((share, index) => {
    const cap = capacities[index]!;
    if (share.gt(cap)) {
      excess += share.fen - cap.fen;
      return cap;
    }
    return share;
  });

  for (let index = 0; index < out.length && excess > 0; index += 1) {
    const slack = capacities[index]!.fen - out[index]!.fen;
    if (slack <= 0) continue;
    const moved = Math.min(slack, excess);
    out[index] = Money.fromFen(out[index]!.fen + moved);
    excess -= moved;
  }
  return out;
}

/**
 * Applies every adjustment in the order given and returns the per-line shares.
 *
 * A contributor may hand back its own `perLine` split (the coupon does, because
 * only the lines inside its scope may be discounted); that split is clamped the
 * same way, and whatever it could not place is redistributed over the lines it
 * was allowed to touch, never over the others.
 *
 * Only discounts are honoured. A non-negative `amount` is ignored rather than
 * turned into a surcharge: `orders.coupon_discount` is `>= 0` by CHECK, and
 * "the price went up at checkout" is not a behaviour this shop has.
 */
export function splitAdjustments(
  lines: readonly { subtotal: Money }[],
  adjustments: readonly PriceAdjustment[],
): DiscountSplit {
  const remaining = lines.map((line) => line.subtotal);
  const perLine = lines.map(() => Money.ZERO);
  const applied: AppliedAdjustment[] = [];

  for (const adjustment of adjustments) {
    if (!adjustment.amount.isNegative()) continue;

    const scoped = adjustment.perLine;
    const capacities = scoped
      ? remaining.map((left, index) => Money.min(left, (scoped[index] ?? Money.ZERO).abs()))
      : remaining;

    const shares = distribute(adjustment.amount.abs(), capacities);
    const moved = Money.sum(shares);
    if (moved.isZero()) continue;

    for (let index = 0; index < shares.length; index += 1) {
      const share = shares[index]!;
      perLine[index] = perLine[index]!.add(share);
      remaining[index] = remaining[index]!.sub(share);
    }
    applied.push({
      source: adjustment.source,
      label: adjustment.label,
      amount: moved.negate(),
      perLine: shares.map((share) => share.negate()),
    });
  }

  return { total: Money.sum(perLine), perLine, applied };
}

/**
 * Turns a coupon quote into an adjustment whose `perLine` is zero outside the
 * coupon's scope. Keeping the scope in `perLine` rather than in the splitter
 * means the splitter stays ignorant of what a coupon is.
 */
export function couponAdjustment(args: {
  label: string;
  discount: Money;
  lines: readonly { subtotal: Money }[];
  eligibleLineIndexes: readonly number[];
}): PriceAdjustment {
  const eligible = new Set(args.eligibleLineIndexes);
  const capacities = args.lines.map((line, index) =>
    eligible.has(index) ? line.subtotal : Money.ZERO,
  );
  return {
    source: 'coupon:discount',
    label: args.label,
    amount: args.discount.abs().negate(),
    perLine: distribute(args.discount, capacities),
  };
}

/** `itemsAmount + freight - discount`, floored at zero. */
export function payableOf(items: Money, freight: Money, discount: Money): Money {
  return items.add(freight).sub(discount).clampToZero();
}

// ---------------------------------------------------------------------------
// freight
// ---------------------------------------------------------------------------

/**
 * `product_skus.weight` is `numeric(12,3)` kilograms and `volume` is
 * `numeric(12,4)` cubic metres; the `FreightPort` wants integer grams and
 * cubic centimetres. These are the only two places in the domain that touch a
 * float, and deliberately so: they are measurements, not money, and `Money`
 * refuses more than two fraction digits for exactly the reason it should.
 */
function unitsOf(value: string | null, perUnit: number): number {
  if (value === null || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * perUnit) : 0;
}

const gramsOf = (weightKg: string | null): number => unitsOf(weightKg, 1_000);
const cubicCentimetresOf = (volumeM3: string | null): number => unitsOf(volumeM3, 1_000_000);

/**
 * The `FreightPort` line for one priced line. Freight is quoted on the goods
 * *before* any discount, which is what "满 99 包邮" has always meant in this
 * shop and what the shipping templates assume.
 *
 * `templateOverride` is an activity's own 运费模板: when there is one, the line
 * is charged by it whatever the product says.
 */
export function freightLineOf(
  line: {
    sku: SkuForSale;
    quantity: number;
    subtotal: Money;
  },
  templateOverride: number | null = null,
): FreightLine {
  if (templateOverride !== null) {
    return {
      skuId: line.sku.skuId,
      quantity: line.quantity,
      freightTemplateId: templateOverride,
      freightMode: 'template',
      fixedFreightFen: 0,
      weight: gramsOf(line.sku.weight) * line.quantity,
      volume: cubicCentimetresOf(line.sku.volume) * line.quantity,
      amountFen: line.subtotal.fen,
    };
  }
  return {
    skuId: line.sku.skuId,
    quantity: line.quantity,
    freightTemplateId: line.sku.shippingTemplateId,
    // The mode travels with the line because only this side has the
    // `SkuForSale` in hand; `null` template plus 'free' and `null` template
    // plus 'fixed' are two different prices and the port cannot tell them apart
    // from a template id.
    freightMode: line.sku.freightMode,
    fixedFreightFen:
      line.sku.freightMode === 'fixed' ? Money.parseOrZero(line.sku.fixedFreight).fen : 0,
    weight: gramsOf(line.sku.weight) * line.quantity,
    volume: cubicCentimetresOf(line.sku.volume) * line.quantity,
    amountFen: line.subtotal.fen,
  };
}

/** `PricingDraft.lines`, for the contributors. */
export function pricingLineOf(line: {
  sku: SkuForSale;
  quantity: number;
  unitPrice: Money;
  subtotal: Money;
}): PricingLine {
  return {
    skuId: line.sku.skuId,
    productId: line.sku.productId,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    subtotal: line.subtotal,
  };
}
