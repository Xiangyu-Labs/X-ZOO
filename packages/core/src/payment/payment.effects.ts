import { registerEffectHandler, type Effect } from '../effects';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { refundException } from './payment.service';
import { findException } from './payment.repo';

/**
 * Payment's post-commit side effects.
 *
 * Exactly one, and it is the one that moves money: when a verified payment
 * cannot be booked against an order, the callback transaction records a
 * `payment_exceptions` row *and* this effect, in the same transaction. The
 * refund then happens after that transaction has committed, which is the only
 * ordering that cannot lose money — an in-transaction gateway call would either
 * refund something we then rolled back, or roll back a refund the gateway
 * already made.
 *
 * Delivery is at-least-once, so the handler has to be idempotent. It is,
 * twice over: `claimExceptionForRefund` freezes the refund number on the row
 * and only moves `open|refund_failed → refunding`, and WeChat itself treats a
 * repeated `out_refund_no` with the same amount as the same refund.
 *
 * A row an operator has already handled (`refunded`, `ignored`) makes the
 * handler a no-op rather than an error: the human beat the machine to it, which
 * is a success, not a failure to retry.
 *
 * The second registration, `('order', 'order.paid')`, is the hand-off row every
 * booked payment records (see `logOrderPaid`).
 */
export function registerPaymentEffects(): void {
  registerEffectHandler('order', 'order.paid', logOrderPaid);
  registerEffectHandler('payment', 'payment.exception.refund', async (ctx, effect) => {
    const exceptionId = Number(effect.scopeId);
    if (!Number.isInteger(exceptionId)) {
      throw new Error(`payment.exception.refund: 非法 scopeId ${effect.scopeId}`);
    }

    const row = await findException(ctx.db, exceptionId);
    if (!row) {
      ctx.logger.warn({ exceptionId }, 'payment exception vanished before its refund ran');
      return;
    }
    if (row.status === 'refunded' || row.status === 'ignored') return;
    if (row.transactionId === '') return;

    try {
      await refundException(ctx, exceptionId, { operatorAdminId: null });
    } catch (error) {
      // A gateway refusal is final for this attempt — retrying a NOT_ENOUGH
      // eight times helps nobody — so the row is left `refund_failed` for an
      // operator and the effect is allowed to finish. Anything else throws, and
      // the ledger's backoff brings it round again.
      if (error instanceof DomainError && error.code === 'PAYMENT_GATEWAY_REFUSED') {
        ctx.logger.error(
          { exceptionId, err: error },
          'automatic exception refund refused by the gateway; left for an operator',
        );
        return;
      }
      throw error;
    }
  });
}

/**
 * `order.paid` is recorded in every payment transaction as the extension point
 * for what hangs off a paid order after commit — 订阅消息, a receipt printer, an
 * ERP push. None of those is built: the in-transaction work (the stock commit,
 * the campaign seats, auto-delivery, the 站内信) runs on `onOrderPaid` hooks.
 *
 * So the row is delivered to a logged no-op rather than left without a handler:
 * an unhandled effect retries eight times and parks as `unknown`, which would
 * give an operator one row per paid order in 待处理任务 that no action clears.
 * The row itself stays, as the ledger's record that the payment was booked; a
 * real consumer replaces this registration.
 */
async function logOrderPaid(ctx: Ctx, effect: Effect): Promise<void> {
  ctx.logger.info(
    { scope: effect.scope, scopeId: effect.scopeId, event: effect.eventType },
    'order.paid: no post-commit consumer registered',
  );
}
