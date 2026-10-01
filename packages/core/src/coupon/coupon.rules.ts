import type { CouponScope, CouponValidityMode } from '@shop/contracts/coupon/schemas';
import { Money } from '../kernel/money';

/**
 * The coupon rules that are pure arithmetic: which cart lines a coupon covers,
 * what it takes off, and when it is valid.
 *
 * Everything here is a function of its arguments — no `ctx`, no database, no
 * clock — which is why it is in its own file and has a plain unit test
 * (`coupon.rules.test.ts`, no Docker). The service does the I/O and calls
 * these; the integration tests then only have to prove the I/O.
 *
 * Two rules that are easy to get wrong:
 *
 *  - `min_spend` is compared against the **eligible** subtotal, not the whole
 *    cart. A 品类券 on a ¥200 cart with ¥30 of eligible goods does not meet a
 *    ¥100 threshold.
 *  - the discount is **capped at the eligible subtotal**, so a ¥50 coupon on
 *    ¥30 of eligible goods takes off ¥30, never ¥50.
 */

/** A cart line as the caller describes it. The coupon domain never resolves a product itself. */
export interface CouponLine {
  productId: number;
  /** Every category the product is in, ancestors included. Resolved by the caller. */
  categoryIds: readonly number[];
  amount: Money;
}

/** The applicability facts about one coupon, however they were loaded. */
export interface CouponTerms {
  scope: CouponScope;
  /** Non-empty only for `scope = 'products'`. */
  productIds: readonly number[];
  /** Non-empty only for `scope = 'categories'`. */
  categoryIds: readonly number[];
  discountAmount: Money;
  minSpend: Money;
}

export type QuoteRefusal = 'COUPON_NOT_APPLICABLE' | 'COUPON_MIN_SPEND_NOT_MET';

export interface QuoteOk {
  ok: true;
  discount: Money;
  /** Indexes into the `lines` array that the coupon covers. */
  eligibleLineIndexes: number[];
  eligibleSubtotal: Money;
}

export interface QuoteRefused {
  ok: false;
  reason: QuoteRefusal;
  eligibleLineIndexes: number[];
  eligibleSubtotal: Money;
}

export type QuoteOutcome = QuoteOk | QuoteRefused;

/** Which lines this coupon covers. `all_products` covers everything, including lines with no category. */
export function eligibleLineIndexes(terms: CouponTerms, lines: readonly CouponLine[]): number[] {
  if (terms.scope === 'all_products') return lines.map((_line, index) => index);

  if (terms.scope === 'products') {
    const wanted = new Set(terms.productIds);
    return lines.flatMap((line, index) => (wanted.has(line.productId) ? [index] : []));
  }

  const wanted = new Set(terms.categoryIds);
  return lines.flatMap((line, index) =>
    line.categoryIds.some((categoryId) => wanted.has(categoryId)) ? [index] : [],
  );
}

/**
 * What this coupon would take off this cart, or why it would not apply.
 *
 * Returns an outcome rather than throwing: the checkout picker lists unusable
 * coupons greyed out with the reason, and a thrown error cannot be put in a
 * list. `quote()` in `index.ts` is the throwing wrapper for the one-coupon case
 * that checkout calls.
 */
export function quoteLines(terms: CouponTerms, lines: readonly CouponLine[]): QuoteOutcome {
  const indexes = eligibleLineIndexes(terms, lines);
  const eligibleSubtotal = Money.sum(indexes.map((index) => lines[index]!.amount));

  if (indexes.length === 0) {
    return {
      ok: false,
      reason: 'COUPON_NOT_APPLICABLE',
      eligibleLineIndexes: [],
      eligibleSubtotal,
    };
  }
  if (eligibleSubtotal.lt(terms.minSpend)) {
    return {
      ok: false,
      reason: 'COUPON_MIN_SPEND_NOT_MET',
      eligibleLineIndexes: indexes,
      eligibleSubtotal,
    };
  }
  return {
    ok: true,
    // Capped at what the eligible lines are worth: a coupon can never create money.
    discount: Money.min(terms.discountAmount, eligibleSubtotal),
    eligibleLineIndexes: indexes,
    eligibleSubtotal,
  };
}

// ---------------------------------------------------------------------------
// validity windows
// ---------------------------------------------------------------------------

/** How a template says its coupons expire. */
export interface ValidityTerms {
  validityMode: CouponValidityMode;
  validFrom: Date | null;
  validTo: Date | null;
  validDays: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The window a coupon issued *now* would carry.
 *
 * `fixed_window` copies the template's dates; `days_after_claim` starts at
 * `issuedAt`. The schema CHECK `coupon_templates_validity_shape` guarantees the
 * fields the chosen mode needs are present, so a missing one is a programming
 * error rather than bad data — hence the throw.
 */
export function windowForIssue(terms: ValidityTerms, issuedAt: Date): { from: Date; to: Date } {
  if (terms.validityMode === 'fixed_window') {
    if (!terms.validFrom || !terms.validTo) {
      throw new Error('coupon template: fixed_window 缺少 validFrom/validTo');
    }
    return { from: terms.validFrom, to: terms.validTo };
  }
  if (!terms.validDays) {
    throw new Error('coupon template: days_after_claim 缺少 validDays');
  }
  return { from: issuedAt, to: new Date(issuedAt.getTime() + terms.validDays * MS_PER_DAY) };
}

/** `validFrom <= now <= validTo`. Both ends inclusive, like the redemption guard. */
export function isWithinWindow(now: Date, from: Date, to: Date): boolean {
  return now.getTime() >= from.getTime() && now.getTime() <= to.getTime();
}

/**
 * Whether a template can be claimed at `now`, ignoring supply and per-user
 * limits (which are decided by the database, not by a read).
 *
 * A `fixed_window` template whose spending window has already closed is not
 * claimable even if its claim window is still open: issuing a coupon that is
 * dead on arrival is how support tickets are made.
 */
export function isClaimWindowOpen(
  terms: ValidityTerms & { claimFrom: Date | null; claimTo: Date | null },
  now: Date,
): boolean {
  if (terms.claimFrom && now.getTime() < terms.claimFrom.getTime()) return false;
  if (terms.claimTo && now.getTime() > terms.claimTo.getTime()) return false;
  if (terms.validityMode === 'fixed_window' && terms.validTo) {
    if (now.getTime() > terms.validTo.getTime()) return false;
  }
  return true;
}
