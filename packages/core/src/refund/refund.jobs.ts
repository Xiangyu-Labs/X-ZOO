import type { Ctx } from '../kernel/context';
import { listExecutableRefunds } from './refund.repo';
import { reconcileRefund } from './refund.service';

/**
 * The refund reconciliation sweep.
 *
 * It exists because we might have missed a refund notification — a deploy, a
 * network blip or a 500 eats one, and WeChat eventually stops retrying. A shop
 * that only learns about refunds from callbacks leaves buyers waiting for money
 * that already moved, or, worse, believes money moved that did not.
 *
 * Every row is resolved by *querying the frozen `out_refund_no`*, never by
 * re-sending and never by elapsed time (REFUND-006). Safe to run beside a
 * callback for the same row: both end in the same conditional update, so the
 * second one sees a settled refund rather than booking a second one.
 */

export interface RefundSweepReport {
  examined: number;
  succeeded: number;
  processing: number;
  failed: number;
  errored: number;
}

export interface RefundSweepOptions {
  /** Only look at rows untouched for this long. Default 5 minutes. */
  staleAfterMs?: number;
  limit?: number;
}

const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_LIMIT = 50;

export async function reconcileStaleRefunds(
  ctx: Ctx,
  options: RefundSweepOptions = {},
): Promise<RefundSweepReport> {
  const report: RefundSweepReport = {
    examined: 0,
    succeeded: 0,
    processing: 0,
    failed: 0,
    errored: 0,
  };
  const olderThan = new Date(
    ctx.clock.now().getTime() - (options.staleAfterMs ?? DEFAULT_STALE_MS),
  );
  const rows = await listExecutableRefunds(ctx.db, {
    olderThan,
    limit: options.limit ?? DEFAULT_LIMIT,
  });

  for (const row of rows) {
    report.examined += 1;
    try {
      const result = await reconcileRefund(ctx, row.id);
      if (result.status === 'succeeded') report.succeeded += 1;
      else if (result.status === 'processing') report.processing += 1;
      else report.failed += 1;
    } catch (error) {
      report.errored += 1;
      ctx.logger.error(
        { err: error, refundId: row.id, outRefundNo: row.outRefundNo },
        'refund reconciliation failed',
      );
    }
  }
  return report;
}
