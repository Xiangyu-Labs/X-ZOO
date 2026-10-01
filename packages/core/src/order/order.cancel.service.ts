import type { OrderCancelBody, OrderDetail } from '@shop/contracts/order/schemas';
import type { Tx } from '@shop/db';
import * as coupon from '../coupon';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { resolvePaymentPort, resolveStockPort } from './catalog.port';
import { orderConfig } from './order.config';
import { autoCancelKey, unpaidReminderKey } from './order.checkout.service';
import { detailOf } from './order.query.service';
import { requireOrderRef } from './order.ref';
import * as repo from './order.repo';
import { onOrderCancelled, type OrderStatus, type PaymentState } from './ports';
import { orderStateMachine } from './order.state-machine';

/**
 * Cancellation — the user's, the timeout's and the admin's — behind **one**
 * entry point.
 *
 * Three entry points would each grow their own idea of what to give back; the
 * one that forgot the coupon would let a timed-out order quietly eat it.
 *
 * The order of operations is the whole safety argument:
 *
 *  0. **outside** any transaction, `PaymentPort.closeOrderPayments` asks the
 *     gateway to close every open attempt: `closed` proceeds, `paid` refuses,
 *     `unknown` refuses and releases *nothing* (never guess). It is outside
 *     because it talks to WeChat, and a row lock held for the length of a
 *     gateway round trip is how a checkout table seizes up;
 *  1. `SELECT … FOR UPDATE` on the order, so a payment cannot start underneath;
 *  2. ask `PaymentPort` *again*, **while holding it** — `ensureNoOpenAttempts`
 *     is database-only and this is the re-check that catches an attempt opened
 *     between step 0 and the lock. Same three answers, same three outcomes;
 *  3. one conditional `pending_payment -> cancelled` transition. Exactly one
 *     caller can win it, which is what makes the auto-cancel job and the user's
 *     tap safe to race;
 *  4. only the winner gives back the stock and the coupon, in the same
 *     transaction, so QUEUE-006's "both or neither" holds by construction.
 *
 * Steps 0 and 2 are the payment port's two-call protocol. Without step 0, every
 * order whose buyer had opened the WeChat sheet and backed out would answer
 * `unknown` forever: the 取消订单 button would refuse them and the sweep would
 * skip exactly the orders it exists for.
 *
 * A paid order is never cancelled — `ORDER_TRANSITIONS` has no such edge. It
 * leaves through the refund domain's full refund.
 */

export type CancelReason = 'user' | 'timeout' | 'admin' | 'payment-failed';

export interface CancelInput {
  orderId: number;
  reason: CancelReason;
  /** Free text for the timeline and for `orders.cancel_reason`. */
  message?: string;
  /** Set for a user-initiated cancellation; recorded on the audit row. */
  userId?: number;
  /**
   * `true` turns "somebody else got there first" into an error. The job path
   * leaves it false: losing that race to the shopper is the system working.
   */
  strict?: boolean;
  /** Refuse to cancel an order whose payment window has not closed yet. */
  onlyIfExpired?: boolean;
}

export interface CancelOutcome {
  cancelled: boolean;
  /** The status the order ended up in, whoever won. */
  status: OrderStatus;
}

const DEFAULT_MESSAGE: Record<CancelReason, string> = {
  user: '用户取消订单',
  timeout: '超时未支付，系统自动取消',
  admin: '管理员取消订单',
  'payment-failed': '支付失败，订单已取消',
};

/**
 * Step 2, under the order lock: is any attempt still open (or already paid)?
 * Exported inside the domain for 改价, which needs the same answer.
 */
export async function openPaymentState(ctx: Ctx, tx: Tx, orderId: number): Promise<PaymentState> {
  const port = resolvePaymentPort();
  if (port) return port.ensureNoOpenAttempts(tx, orderId);
  ctx.logger.debug({ orderId }, 'no PaymentPort registered; treating payment as closed');
  return 'closed';
}

/**
 * Step 0: the gateway round trip, outside every transaction.
 *
 * Exported inside the domain (not from `index.ts`) so the sweep can run a batch
 * of these in parallel before it starts cancelling one order at a time.
 */
export async function closeOrderPayments(ctx: Ctx, orderId: number): Promise<PaymentState> {
  const port = resolvePaymentPort();
  if (port) return port.closeOrderPayments(ctx, orderId);
  ctx.logger.debug({ orderId }, 'no PaymentPort registered; nothing to close');
  return 'closed';
}

/** `paid` and `unknown` are refusals, and they are refusals in both steps. */
function refuseOn(state: PaymentState): void {
  if (state === 'paid') throw new DomainError('ORDER_ALREADY_PAID');
  if (state === 'unknown') throw new DomainError('ORDER_PAYMENT_STATE_UNKNOWN');
}

/**
 * The one cancellation. Everything else in the system — the route, the delayed
 * job, the sweep, a future admin action — calls this.
 */
export async function cancelOrder(ctx: Ctx, input: CancelInput): Promise<CancelOutcome> {
  const now = ctx.clock.now();
  const strict = input.strict ?? false;
  const message = input.message?.trim() || DEFAULT_MESSAGE[input.reason];

  // Step 0. Outside the transaction: this one talks to WeChat. `closed` here
  // is not a promise that it will still be closed under the lock — step 2 is
  // what makes that true — it is a promise that nothing we opened is still
  // collectible.
  refuseOn(await closeOrderPayments(ctx, input.orderId));

  const outcome = await ctx.withTx(async (tx): Promise<CancelOutcome> => {
    const order = await repo.lockOrder(tx, input.orderId);
    if (!order) throw new DomainError('ORDER_NOT_FOUND');

    if (order.status !== 'pending_payment') {
      if (strict)
        throw new DomainError('ORDER_NOT_CANCELLABLE', { details: { status: order.status } });
      return { cancelled: false, status: order.status };
    }

    // A delayed job can fire early after a clock change or a re-enqueue; the
    // window is re-read here, under the lock, rather than trusted.
    if (input.onlyIfExpired && (order.payExpiresAt === null || order.payExpiresAt > now)) {
      return { cancelled: false, status: order.status };
    }

    // Step 2. The re-check, under the lock. Database-only by contract, and the
    // reason an attempt that opened between step 0 and here cannot slip past.
    refuseOn(await openPaymentState(ctx, tx, input.orderId));

    const moved = await orderStateMachine.transition(
      tx,
      order.id,
      ['pending_payment'],
      'cancelled',
      { at: now, cancelReason: message, payExpiresAt: null },
    );
    if (!moved.won) {
      if (strict) throw new DomainError('ORDER_NOT_CANCELLABLE');
      return { cancelled: false, status: moved.observed ?? order.status };
    }

    // Stock first: it is ours, it cannot refuse, and it must come back even if
    // the order had no coupon.
    const lines = await repo.stockLinesOf(tx, order.id);
    await resolveStockPort().release(tx, order.id, lines);

    if (order.userCouponId !== null) {
      const released = await coupon.release(tx, ctx, {
        userCouponId: order.userCouponId,
        orderId: order.id,
      });
      // QUEUE-006: the coupon and the stock come back together or not at all.
      // Throwing here rolls the transition back too, leaving the order live.
      if (!released.released) throw new DomainError('ORDER_COUPON_RELEASE_FAILED');
    }

    await repo.insertStatusLog(tx, {
      orderId: order.id,
      changeType: input.reason === 'timeout' ? 'auto_cancelled' : 'cancelled',
      fromStatus: 'pending_payment',
      toStatus: 'cancelled',
      message,
      operatorKind:
        input.reason === 'user' ? 'user' : input.reason === 'admin' ? 'admin' : 'system',
      ...(input.reason === 'user' && input.userId !== undefined
        ? { operatorUserId: input.userId }
        : {}),
    });

    // Hooks run inside this transaction, so a domain that cannot do its part
    // (group-buy releasing a team seat) aborts the cancellation rather than
    // leaving the two halves disagreeing.
    await onOrderCancelled.dispatch(tx, ctx, {
      orderId: order.id,
      orderNo: order.orderNo,
      userId: order.userId,
      at: now,
      reason: input.reason,
    });

    return { cancelled: true, status: 'cancelled' };
  });

  if (outcome.cancelled) {
    // The delayed auto-cancel and the 未付款提醒 have nothing left to do.
    // Dropping them is a courtesy: both jobs re-read the order and would
    // simply find it cancelled.
    await ctx.queue.cancel(autoCancelKey(input.orderId));
    await ctx.queue.cancel(unpaidReminderKey(input.orderId));
    ctx.logger.info({ orderId: input.orderId, reason: input.reason }, 'order cancelled');
  }
  return outcome;
}

/** `POST /api/v1/orders/:id/cancel`. */
export async function cancel(
  ctx: Ctx,
  params: { id: string },
  body: OrderCancelBody,
): Promise<OrderDetail> {
  const { orderId, userId } = await requireOrderRef(ctx, params.id);

  // Ownership first, so a stranger gets 404 rather than a lock and a 409.
  const owned = await repo.findOrderForUser(ctx.db, { id: orderId, userId });
  if (!owned) throw new DomainError('ORDER_NOT_FOUND');

  await cancelOrder(ctx, {
    orderId,
    reason: 'user',
    userId,
    strict: true,
    ...(body.reason ? { message: body.reason } : {}),
  });
  return detailOf(ctx, { orderId, userId });
}

/**
 * The per-order delayed job. Never throws for a lost race: by the time it runs
 * the shopper may have paid, or cancelled it themselves, and both are fine.
 *
 * It goes through `cancelOrder`, so it runs the same two-call protocol: the
 * buyer who opened the WeChat sheet and walked away has their attempt closed
 * here rather than blocking the timeout forever. It *does* throw for
 * `ORDER_ALREADY_PAID` and `ORDER_PAYMENT_STATE_UNKNOWN` — those are not lost
 * races, they are the job declining to guess, and the queue's retry (or the
 * sweep) is the right answer to both.
 */
export async function autoCancel(ctx: Ctx, input: { orderId: number }): Promise<CancelOutcome> {
  return cancelOrder(ctx, {
    orderId: input.orderId,
    reason: 'timeout',
    onlyIfExpired: true,
  });
}

/**
 * How many gateway closes the sweep has in flight at once.
 *
 * The sweep's limit is 200 orders, and each of them may owe WeChat a round
 * trip. One at a time makes the sweep as slow as the gateway; all at once
 * makes us the thing hammering it. Five is small enough to be polite and large
 * enough that a single slow close does not set the pace.
 */
const SWEEP_CLOSE_CONCURRENCY = 5;

/** `fn` over `items`, at most `limit` in flight, results in input order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The backstop sweep. The delayed job does the real work; this exists because
 * a queue can lose a job and an order must not stay `pending_payment` forever
 * holding stock. Nothing depends on it for correctness.
 *
 * It runs the gateway closes first, `SWEEP_CLOSE_CONCURRENCY` at a time, and
 * only then cancels — one order at a time, because that half is all database
 * work under a row lock. An order whose close did not answer `closed` is
 * skipped and logged; it keeps its stock and its coupon, and the next sweep
 * tries it again. One silent gateway must never cost the other 199 orders
 * their sweep.
 */
export async function sweepExpiredOrders(ctx: Ctx, options: { limit?: number } = {}) {
  const { autoCancelSweepLimit } = await ctx.config.get(orderConfig);
  const ids = await repo.listExpiredUnpaid(ctx.db, {
    now: ctx.clock.now(),
    limit: options.limit ?? autoCancelSweepLimit,
  });

  const states = await mapWithLimit(ids, SWEEP_CLOSE_CONCURRENCY, async (orderId) => {
    try {
      return await closeOrderPayments(ctx, orderId);
    } catch (error) {
      // A close that throws is indistinguishable from one that answers
      // `unknown`: we do not know, so we release nothing.
      ctx.logger.warn({ err: error, orderId }, 'expired order sweep: closing the payment failed');
      return 'unknown' as PaymentState;
    }
  });

  let cancelled = 0;
  let skipped = 0;
  for (const [index, orderId] of ids.entries()) {
    const state = states[index]!;
    if (state !== 'closed') {
      // `paid` is a shopper who beat the sweep; `unknown` is a gateway that
      // would not say. Both keep every reservation and come back next sweep.
      skipped += 1;
      ctx.logger.info({ orderId, state }, 'expired order sweep: skipping, payment not closed');
      continue;
    }
    try {
      // `cancelOrder` closes again, which is now a database read finding
      // nothing open — and the honest gateway call if an attempt opened since.
      const outcome = await autoCancel(ctx, { orderId });
      if (outcome.cancelled) cancelled += 1;
    } catch (error) {
      // One order that cannot be cancelled must not stop the sweep reaching
      // the rest.
      skipped += 1;
      ctx.logger.warn({ err: error, orderId }, 'expired order sweep: cancel failed');
    }
  }
  return { scanned: ids.length, cancelled, skipped };
}
