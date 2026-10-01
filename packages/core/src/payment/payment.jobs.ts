import type { Ctx } from '../kernel/context';
import { closeOrderPayments, reconcileAttempt, recheckException } from './payment.service';
import {
  listExpiredUnpaidOrders,
  listStaleAttempts,
  listUnsettledExceptions,
} from './payment.repo';

/**
 * The reconciliation sweeps.
 *
 * Every one of them exists because *we might have missed a notification*. A
 * shop that only learns about money from callbacks is a shop that loses money
 * whenever a deploy, a network blip or a 500 eats one — and WeChat gives up
 * retrying eventually. So the ledger is periodically re-derived from the
 * gateway, by the frozen merchant order number, and never from elapsed time.
 *
 * All three are safe to run concurrently with a callback for the same row: the
 * settlement path they share locks the attempt and decides on affected row
 * counts, so whoever gets there second sees a replay rather than a second
 * booking.
 */

export interface SweepReport {
  examined: number;
  paid: number;
  closed: number;
  unknown: number;
  failed: number;
}

const emptyReport = (): SweepReport => ({
  examined: 0,
  paid: 0,
  closed: 0,
  unknown: 0,
  failed: 0,
});

export interface SweepOptions {
  /** Only look at rows untouched for this long. Default 5 minutes. */
  staleAfterMs?: number;
  limit?: number;
}

const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_LIMIT = 50;

/**
 * Asks the gateway about every attempt that has sat in a non-final state.
 *
 * `submitted` rows are included, not just `unknown` ones: a lost notification
 * leaves a perfectly healthy-looking `submitted` row behind, and that is
 * exactly the money nobody would otherwise notice.
 */
export async function reconcileStalePayments(
  ctx: Ctx,
  options: SweepOptions = {},
): Promise<SweepReport> {
  const report = emptyReport();
  const olderThan = new Date(
    ctx.clock.now().getTime() - (options.staleAfterMs ?? DEFAULT_STALE_MS),
  );
  const attempts = await listStaleAttempts(ctx.db, {
    olderThan,
    limit: options.limit ?? DEFAULT_LIMIT,
  });

  for (const attempt of attempts) {
    report.examined += 1;
    try {
      const state = await reconcileAttempt(ctx, attempt.id);
      report[state] += 1;
    } catch (error) {
      report.failed += 1;
      ctx.logger.error(
        { err: error, attemptId: attempt.id, outTradeNo: attempt.outTradeNo },
        'payment reconciliation failed',
      );
    }
  }
  return report;
}

/**
 * Closes the gateway orders of orders whose payment window has passed.
 *
 * It does *not* cancel the order: cancelling is the order domain's, and it
 * releases stock and coupons. This sweep only makes the money side final, so
 * that when the order auto-cancel runs, `ensureNoOpenAttempts` can answer
 * `closed` truthfully instead of blocking on an `unknown` forever.
 */
export async function closeExpiredPayments(
  ctx: Ctx,
  options: SweepOptions = {},
): Promise<SweepReport> {
  const report = emptyReport();
  const orders = await listExpiredUnpaidOrders(ctx.db, {
    now: ctx.clock.now(),
    limit: options.limit ?? DEFAULT_LIMIT,
  });

  for (const { orderId } of orders) {
    report.examined += 1;
    try {
      const state = await closeOrderPayments(ctx, orderId);
      report[state] += 1;
    } catch (error) {
      report.failed += 1;
      ctx.logger.error({ err: error, orderId }, 'closing an expired payment failed');
    }
  }
  return report;
}

/**
 * Chases refunds of payment exceptions whose result never came back. Asks by
 * the frozen refund number; never re-submits (REFUND-005).
 */
export async function recheckExceptionRefunds(
  ctx: Ctx,
  options: SweepOptions = {},
): Promise<SweepReport> {
  const report = emptyReport();
  const olderThan = new Date(
    ctx.clock.now().getTime() - (options.staleAfterMs ?? DEFAULT_STALE_MS),
  );
  const rows = await listUnsettledExceptions(ctx.db, {
    olderThan,
    limit: options.limit ?? DEFAULT_LIMIT,
  });

  for (const row of rows) {
    report.examined += 1;
    if (row.refundNo === null) continue;
    try {
      const fresh = await recheckException(ctx, row.id);
      if (fresh.status === 'refunded') report.paid += 1;
      else if (fresh.status === 'refund_failed') report.closed += 1;
      else report.unknown += 1;
    } catch (error) {
      report.failed += 1;
      ctx.logger.error(
        { err: error, exceptionId: row.id },
        'rechecking an exception refund failed',
      );
    }
  }
  return report;
}
