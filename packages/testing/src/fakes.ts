import type { DbOrTx } from '@shop/db';
import type {
  FreightPort,
  FreightQuote,
  OrderStateMachine,
  PaymentPort,
  PaymentState,
  PricingContributor,
  StockLine,
  StockPort,
} from '@shop/core/order/ports';
import { ORDER_TRANSITIONS } from '@shop/core/order/ports';
import type { UserAuthState, UserLookup } from '@shop/core/auth';
import type { CaptchaVerifier } from '@shop/core/auth';

/**
 * In-memory implementations of the cross-domain ports in
 * `core/src/order/ports.ts`.
 *
 * A domain's tests register the fake for every port they do not exercise, so
 * order cancellation can be tested without payment behind it and a refund
 * without freight. Swapping a fake for the real implementation is one
 * `register…` call.
 */

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

export interface FakePaymentPort extends PaymentPort {
  /** Every `ensureNoOpenAttempts` call, in order. */
  calls: number[];
  /** Every `closeOrderPayments` call, in order — the pre-transaction half. */
  closes: number[];
  /** Change the answer mid-test. Sets both halves unless `closeResult` was given. */
  setResult(result: PaymentState): void;
  /** Change only what `closeOrderPayments` answers, leaving the in-lock re-check alone. */
  setCloseResult(result: PaymentState): void;
}

/**
 * `fakePaymentPort({ result: 'unknown' })` is how the order tests prove the
 * cancel path refuses and keeps every reservation when the gateway will not
 * answer.
 *
 * Both halves of the two-call protocol answer the same thing by default, which
 * is what a real gateway does when nothing changes underneath. `closeResult`
 * splits them, so a test can have the close succeed and the re-check under the
 * lock find an attempt that opened in between.
 */
export function fakePaymentPort(
  options: { result?: PaymentState; closeResult?: PaymentState } = {},
): FakePaymentPort {
  let result: PaymentState = options.result ?? 'closed';
  let closeResult: PaymentState | undefined = options.closeResult;
  const calls: number[] = [];
  const closes: number[] = [];
  return {
    calls,
    closes,
    setResult(next) {
      result = next;
    },
    setCloseResult(next) {
      closeResult = next;
    },
    async ensureNoOpenAttempts(_tx, orderId) {
      calls.push(orderId);
      return result;
    },
    async closeOrderPayments(_ctx, orderId) {
      closes.push(orderId);
      return closeResult ?? result;
    },
  };
}

// ---------------------------------------------------------------------------
// Freight
// ---------------------------------------------------------------------------

export interface FakeFreightPort extends FreightPort {
  quotes: FreightQuote[];
}

/**
 * One flat fee for the whole order, split across the lines with the same
 * largest-remainder rule the real one must use, so `perLine` always sums to
 * `totalFen`.
 */
export function flatRateFreight(fen: number): FakeFreightPort {
  const quotes: FreightQuote[] = [];
  return {
    quotes,
    async quote(_db, _ctx, input) {
      const count = input.lines.length;
      if (count === 0) {
        const empty = { totalFen: 0, perLine: [] };
        quotes.push(empty);
        return empty;
      }
      const base = Math.floor(fen / count);
      let left = fen - base * count;
      const perLine = input.lines.map(() => {
        const extra = left > 0 ? 1 : 0;
        left -= extra;
        return base + extra;
      });
      const result = { totalFen: fen, perLine };
      quotes.push(result);
      return result;
    },
  };
}

/** Freight that is always free. The default for tests that do not care. */
export const freeFreight = (): FakeFreightPort => flatRateFreight(0);

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

export interface FakeStockPort extends StockPort {
  /** `skuId -> available`. Mutate directly to set up a "last one left" test. */
  available: Map<number, number>;
  reserved: Map<number, StockLine[]>;
  committed: number[];
  released: number[];
}

export function fakeStockPort(initial: Record<number, number> = {}): FakeStockPort {
  const available = new Map<number, number>(
    Object.entries(initial).map(([sku, qty]) => [Number(sku), qty]),
  );
  const reserved = new Map<number, StockLine[]>();
  const committed: number[] = [];
  const released: number[] = [];

  return {
    available,
    reserved,
    committed,
    released,
    async reserve(_tx, orderId, lines) {
      const short: StockLine[] = [];
      for (const line of lines) {
        const have = available.get(line.skuId) ?? 0;
        if (have < line.quantity) short.push(line);
      }
      if (short.length > 0) return short;
      for (const line of lines) {
        available.set(line.skuId, (available.get(line.skuId) ?? 0) - line.quantity);
      }
      reserved.set(orderId, [...lines]);
      return [];
    },
    async release(_tx, orderId, lines) {
      // Idempotent: releasing twice must not put stock back twice.
      if (!reserved.has(orderId)) return;
      for (const line of lines) {
        available.set(line.skuId, (available.get(line.skuId) ?? 0) + line.quantity);
      }
      reserved.delete(orderId);
      released.push(orderId);
    },
    async commit(_tx, orderId) {
      reserved.delete(orderId);
      committed.push(orderId);
    },
  };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * An in-memory state machine that still behaves like a conditional update:
 * the transition succeeds only if the current status is in `from`, and a second
 * caller loses. Use it to test hook wiring without the order tables.
 */
export function fakeOrderStateMachine(
  initial: Record<number, string> = {},
): OrderStateMachine & { statuses: Map<number, string> } {
  const statuses = new Map<number, string>(
    Object.entries(initial).map(([id, status]) => [Number(id), status]),
  );
  return {
    statuses,
    table: ORDER_TRANSITIONS,
    async transition(_tx, orderId, from, to) {
      const current = statuses.get(orderId);
      if (current === undefined || !from.includes(current as never)) {
        return {
          won: false,
          affected: 0,
          ...(current === undefined ? {} : { observed: current as never }),
        };
      }
      statuses.set(orderId, to);
      return { won: true, affected: 1 };
    },
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** A contributor that always returns the same adjustments. */
export function fixedPricingContributor(
  name: string,
  priority: number,
  adjustments: Awaited<ReturnType<PricingContributor['contribute']>>,
): PricingContributor {
  return { name, priority, contribute: async () => adjustments };
}

// ---------------------------------------------------------------------------
// UserLookup
// ---------------------------------------------------------------------------

export interface FakeUserLookup extends UserLookup {
  users: Map<number, UserAuthState>;
  /** Simulates a password change: bumps the version so sessions die. */
  changePassword(userId: number): void;
  disable(userId: number): void;
}

/**
 * An in-memory `UserLookup`: the storefront session service validates
 * `passwordVersion` through one, and a test that does not want the user
 * domain's tables registers this instead.
 */
export function fakeUserLookup(
  seed: Array<Partial<UserAuthState> & { id: number }> = [],
): FakeUserLookup {
  const users = new Map<number, UserAuthState>();
  for (const user of seed) {
    users.set(user.id, {
      id: user.id,
      passwordVersion: user.passwordVersion ?? 1,
      status: user.status ?? 1,
    });
  }
  return {
    users,
    changePassword(userId) {
      const user = users.get(userId);
      if (user) users.set(userId, { ...user, passwordVersion: user.passwordVersion + 1 });
    },
    disable(userId) {
      const user = users.get(userId);
      if (user) users.set(userId, { ...user, status: 0 });
    },
    async findAuthState(_db: DbOrTx, userId: number) {
      return users.get(userId) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Captcha
// ---------------------------------------------------------------------------

export function fakeCaptchaVerifier(options: { accept?: boolean } = {}): CaptchaVerifier & {
  tokens: string[];
} {
  const tokens: string[] = [];
  return {
    name: 'fake',
    tokens,
    async verify(token) {
      tokens.push(token);
      return options.accept ?? true;
    },
  };
}
