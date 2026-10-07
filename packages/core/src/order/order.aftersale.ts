const DAY_MS = 86_400_000;

/**
 * 售后期 — whether the buyer may still open after-sales on an order (REFUND-022).
 *
 * Until the goods arrive (`paid`, `shipped`) the buyer always may. From 确认收货 —
 * the buyer's tap or the automatic one — the shop's 售后期限 (`afterSaleDays`)
 * runs from `receivedAt`, through `completed`, to the same instant N days later.
 * At `0` there is no window: the buyer may apply while the order is `received`
 * and not once it is `completed`, which is how the shop worked before the
 * setting did anything.
 *
 * Status only: whether any line still has something to give back is the
 * refund domain's question (`refundableLine`).
 */
export function aftersaleOpen(
  order: { status: string; receivedAt: Date | null },
  windowDays: number,
  now: Date,
): boolean {
  switch (order.status) {
    case 'paid':
    case 'shipped':
      return true;
    case 'received':
      return windowDays === 0 || withinWindow(order.receivedAt, windowDays, now);
    case 'completed':
      return windowDays > 0 && withinWindow(order.receivedAt, windowDays, now);
    default:
      return false;
  }
}

/** Counted like the review window (`completeOrder`): whole days of 24 hours from `receivedAt`. */
function withinWindow(receivedAt: Date | null, windowDays: number, now: Date): boolean {
  // A received order always has `receivedAt`; one without it has no window to be inside.
  if (receivedAt === null) return false;
  return now.getTime() <= receivedAt.getTime() + windowDays * DAY_MS;
}
