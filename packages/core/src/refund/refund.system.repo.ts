import type { Tx } from '@shop/db';
import { refunds } from '@shop/db/schema/refund';
import { and, asc, eq, isNull } from 'drizzle-orm';

/**
 * The one query `refund.system.service.ts` needs and `refund.repo.ts` does not
 * have: "has this order already been refunded automatically, and why".
 *
 * It lives in its own `*.repo.ts`, beside the service that uses it, rather than
 * growing `refund.repo.ts`. Same folder, same privacy — nothing outside
 * `core/src/refund/` imports either of them.
 */

export interface SystemRefundRow {
  id: number;
  status: string;
  reason: string | null;
  amount: string;
}

/**
 * Every automatic refund on an order, oldest first.
 *
 * `is_automatic` is TRUE only for a refund the shop opened by itself, so a
 * buyer's own request can never be mistaken for the system's and cancel out a
 * genuine second refund.
 *
 * Soft-deleted rows are excluded: a hidden refund is hidden from the buyer's
 * list, and `deleted_at` here would mean an operator erased the record, in
 * which case the shop genuinely has no automatic refund on file.
 *
 * Called with the order row already locked `FOR UPDATE`, which is what makes
 * "look, then insert" safe against a second sweep in another process.
 */
export async function listAutomaticRefunds(tx: Tx, orderId: number): Promise<SystemRefundRow[]> {
  const rows = await tx
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      amount: refunds.amount,
    })
    .from(refunds)
    .where(
      and(eq(refunds.orderId, orderId), eq(refunds.isAutomatic, true), isNull(refunds.deletedAt)),
    )
    .orderBy(asc(refunds.id));
  return rows as SystemRefundRow[];
}

/** Any refund on the order that actually gave money back. */
export async function findSucceededRefund(
  tx: Tx,
  orderId: number,
): Promise<SystemRefundRow | null> {
  const rows = await tx
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      amount: refunds.amount,
    })
    .from(refunds)
    .where(
      and(eq(refunds.orderId, orderId), eq(refunds.status, 'succeeded'), isNull(refunds.deletedAt)),
    )
    .orderBy(asc(refunds.id))
    .limit(1);
  return (rows[0] as SystemRefundRow | undefined) ?? null;
}
