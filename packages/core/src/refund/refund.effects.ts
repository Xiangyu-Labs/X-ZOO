import { registerEffectHandler, type Effect } from '../effects';
import type { Ctx } from '../kernel/context';
import * as repo from './refund.repo';
import { executeRefund } from './refund.service';

/**
 * Refund's post-commit side effect.
 *
 * Exactly one, and it is the one that moves money: approving a `refund_only`, or
 * confirming that returned goods arrived, records `refund.execute` in the same
 * transaction as the decision. The gateway call then happens after that
 * transaction commits — the only ordering that cannot lose money, because an
 * in-transaction call would either refund something we then rolled back, or roll
 * back a refund WeChat already made.
 *
 * Delivery is at-least-once, so the handler has to be idempotent. It is: the
 * claim inside `executeRefund` only moves a row out of a state that allows
 * execution, and `out_refund_no` is frozen on the row, so a re-send is the same
 * refund as far as WeChat is concerned.
 *
 * The handler deliberately does **not** throw on a refusal or on an unknown
 * answer. Retrying a NOT_ENOUGH eight times helps nobody, and an `unknown` row is
 * the reconciliation sweep's job, not the ledger's — both leave a row an
 * operator can see and act on, which is what the 待处理 console is for.
 */
export function registerRefundEffects(): void {
  registerEffectHandler('order', 'order.refunded', logOrderRefunded);
  registerEffectHandler('refund', 'refund.execute', async (ctx, effect) => {
    const refundId = Number(effect.scopeId);
    if (!Number.isInteger(refundId)) {
      throw new Error(`refund.execute: 非法 scopeId ${effect.scopeId}`);
    }

    const row = await repo.findRefund(ctx.db, refundId);
    if (!row) {
      ctx.logger.warn({ refundId }, 'refund vanished before its gateway call ran');
      return;
    }
    // A human, a sweep or the buyer got there first. Not a failure. A failed
    // refund waits for 复核 or 关闭 by a person, not a replayed effect.
    if (!(repo.OPEN_REFUND_STATUSES as readonly string[]).includes(row.status)) return;
    if (row.status === 'applied' || row.status === 'failed') return;

    const result = await executeRefund(ctx, refundId);
    if (result.status === 'failed' || result.status === 'unknown') {
      ctx.logger.error(
        { refundId, result: result.status, message: result.message },
        'automatic refund did not settle; left for an operator',
      );
    }
  });
}

/**
 * `order.refunded` is recorded when a refund settles, as the extension point
 * for the buyer's notification and anything that hangs off a finished order.
 * The 站内信 already goes out from the in-transaction `onOrderRefunded` hook,
 * and nothing else consumes the row yet.
 *
 * So it is delivered to a logged no-op rather than left without a handler: an
 * unhandled effect retries eight times and parks as `unknown`, one row per
 * refund in 待处理任务 that no operator action clears. The row stays as the
 * ledger's record of the settlement; a real consumer replaces this
 * registration. (It is keyed per order, so it records the order's first settled
 * refund; the `refunds` row and its log are the record of each one.)
 */
async function logOrderRefunded(ctx: Ctx, effect: Effect): Promise<void> {
  ctx.logger.info(
    { scope: effect.scope, scopeId: effect.scopeId, event: effect.eventType },
    'order.refunded: no post-commit consumer registered',
  );
}
