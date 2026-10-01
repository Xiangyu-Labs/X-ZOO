import { HIDEABLE_ORDER_STATUSES, type OrderHidden } from '@shop/contracts/order/schemas';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { requireOrderRef } from './order.ref';
import * as repo from './order.repo';

/**
 * 删除订单, which deletes nothing.
 *
 * It is a flag because the order the buyer swipes away is still the shop's
 * record of a sale. The invoice may not be issued yet, the after-sales window
 * may still be open, and the accountant reconciles against rows nobody may
 * drop. So the button sets `orders.hidden_by_user_at`, the buyer's list stops
 * showing it, and every staff and admin query keeps seeing it — the asymmetry
 * is the feature.
 *
 * Two rules and both are in the WHERE, never in a prior read:
 *
 *  * **only a finished order.** `completed`, `cancelled`, `refunded`. Anything
 *    else is in flight, and a buyer who hides an unshipped order has hidden the
 *    screen they need when it arrives;
 *  * **only once.** `hidden_by_user_at IS NULL` is part of the guard, so two
 *    taps have exactly one winner and a refund landing between a read and this
 *    write cannot leave an in-flight order hidden.
 *
 * The loser cannot tell which rule it lost to, and that is deliberate rather
 * than lazy: after the first tap the order is no longer in this buyer's list,
 * so `ORDER_NOT_FOUND` is the honest description of what they are now pointing
 * at. `ORDER_NOT_DELETABLE` is reserved for the case where the order is still
 * visible and still unfinished — the only one a retry could fix.
 */
export async function hide(ctx: Ctx, params: { id: string }): Promise<OrderHidden> {
  const { orderId, userId } = await requireOrderRef(ctx, params.id);

  return ctx.withTx(async (tx): Promise<OrderHidden> => {
    const result = await repo.hideFromUser(tx, {
      orderId,
      userId,
      from: HIDEABLE_ORDER_STATUSES,
      at: ctx.clock.now(),
    });

    if (!result.won) {
      // Lost, so read the row to say *why* — and read it unscoped by
      // visibility, because the most likely reason is that it is already
      // hidden and the owner-scoped read would answer nothing at all.
      const row = await repo.findOrder(tx, orderId);
      const mine = row !== null && row.userId === userId && row.deletedAt === null;
      const unfinished =
        mine &&
        row.hiddenByUserAt === null &&
        !(HIDEABLE_ORDER_STATUSES as readonly string[]).includes(row.status);
      if (unfinished) throw new DomainError('ORDER_NOT_DELETABLE');
      if (mine && row.hiddenByUserAt === null && (await repo.orderHasOpenRefund(tx, orderId))) {
        throw new DomainError('ORDER_NOT_DELETABLE', {
          message: '订单还有售后在处理，处理完后才能删除',
          details: { openRefund: true },
        });
      }
      throw new DomainError('ORDER_NOT_FOUND');
    }

    await repo.insertStatusLog(tx, {
      orderId,
      changeType: 'hidden_by_user',
      // The status does not move: this is a visibility change, and writing the
      // current status into both columns would claim a transition that the
      // state machine never made.
      fromStatus: null,
      toStatus: null,
      message: '买家删除订单（仅从我的订单隐藏）',
      operatorKind: 'user',
      operatorUserId: userId,
    });

    return { hidden: true };
  });
}
