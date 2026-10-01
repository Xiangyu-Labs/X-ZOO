import type { Tx } from '@shop/db';
import {
  ORDER_TRANSITIONS,
  canTransition,
  type OrderStateMachine,
  type OrderStatus,
  type TransitionResult,
} from './ports';
import * as repo from './order.repo';

/**
 * `OrderStateMachine`, implemented as exactly one statement.
 *
 *     UPDATE orders SET status = $to, ... WHERE id = $id AND status IN ($from)
 *
 * and the decision is the affected row count. Never a read, a branch and then a
 * write: two concurrent 收货 or 发货 requests would both pass the read, and no
 * amount of surrounding transaction makes it safe, because two callers can both
 * read `pending_payment` before either writes.
 *
 * `from` is a **list** because several source states may legitimately lead to
 * one target — `paid | shipped | received | completed -> refunded` for the
 * refund domain's full refund. It goes in the WHERE clause, which is the whole
 * safety property: a caller that read the status first and passed back what it
 * saw would have written a read-then-write with extra steps.
 *
 * Illegal edges are a programming error, not a runtime refusal: `transition`
 * throws when `from -> to` is absent from `ORDER_TRANSITIONS`, so "cancel a
 * shipped order" fails in the first test that tries it instead of quietly
 * affecting zero rows and reading as "somebody else got there first".
 */

export interface TransitionPatch extends Record<string, unknown> {
  /**
   * The instant to stamp into the timestamp column that belongs to `to`
   * (`paid_at`, `cancelled_at`, …). Always `ctx.clock.now()`.
   */
  at?: Date;
}

/**
 * The timestamp each status owns. `orders_paid_shape` and
 * `orders_cancelled_shape` are CHECK constraints, so a caller that forgets one
 * gets a 500 rather than a quietly inconsistent row — applying them here means
 * no caller has to remember.
 */
function stampsFor(to: OrderStatus, at: Date): Record<string, unknown> {
  switch (to) {
    case 'paid':
      return { paidAt: at };
    case 'shipped':
      return { shippedAt: at };
    case 'received':
      return { receivedAt: at };
    case 'completed':
      return { completedAt: at };
    case 'cancelled':
      return { cancelledAt: at };
    default:
      return {};
  }
}

export class OrderStateMachineImpl implements OrderStateMachine {
  readonly table = ORDER_TRANSITIONS;

  async transition(
    tx: Tx,
    orderId: number,
    from: readonly OrderStatus[],
    to: OrderStatus,
    patch: TransitionPatch = {},
  ): Promise<TransitionResult> {
    if (from.length === 0) throw new Error('订单状态机: from 不能为空');
    const illegal = from.filter((source) => !canTransition(source, to, this.table));
    if (illegal.length > 0) {
      throw new Error(`订单状态机不允许 ${illegal.join('/')} -> ${to}`);
    }

    const { at, ...rest } = patch;
    const set = { ...(at ? stampsFor(to, at) : {}), ...rest, status: to };

    const result = await repo.transitionStatus(tx, { orderId, from, to, set });
    if (result.won) return { won: true, affected: result.affected };

    // Cheap, and the caller almost always wants it: we are already here and the
    // row is one primary-key lookup away.
    const observed = await repo.statusOf(tx, orderId);
    return { won: false, affected: 0, ...(observed === null ? {} : { observed }) };
  }
}

/**
 * The instance every caller shares. `order/index.ts` registers it into
 * `ports.ts`, so payment, refund, fulfilment and the kind handlers reach it
 * through `getOrderStateMachine()` without importing this file.
 */
export const orderStateMachine = new OrderStateMachineImpl();
