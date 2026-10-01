import type { Ctx } from '../kernel/context';
import { formatShopTime, notify } from '../notification';
import * as repo from './order.repo';

/**
 * 未付款提醒: tells the buyer their order is about to be cancelled for want of
 * payment.
 *
 * Enqueued by `order.create` for `unpaidReminderMinutes` before the window
 * closes. By the time it runs the buyer may have paid, cancelled, or the order
 * may already be gone, so the order is re-read and only a live, still-payable
 * one is announced. No lock: nothing here changes the order, and `notify`
 * records one effect per order, so a retried or re-enqueued job sends once.
 */
export async function remindUnpaid(
  ctx: Ctx,
  input: { orderId: number },
): Promise<{ sent: boolean }> {
  const now = ctx.clock.now();
  return ctx.withTx(async (tx) => {
    const order = await repo.findOrder(tx, input.orderId);
    if (
      !order ||
      order.status !== 'pending_payment' ||
      order.deletedAt !== null ||
      order.payExpiresAt === null ||
      order.payExpiresAt <= now
    ) {
      return { sent: false };
    }
    await notify(tx, ctx, {
      event: 'order_unpaid_reminder',
      subject: { scope: 'order', id: order.id },
      userId: order.userId,
      data: {
        orderId: order.id,
        orderNo: order.orderNo,
        amount: order.payableAmount,
        expiresAt: formatShopTime(order.payExpiresAt, 'minute'),
      },
    });
    return { sent: true };
  });
}
