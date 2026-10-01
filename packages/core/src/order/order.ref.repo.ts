import type { DbOrTx } from '@shop/db';
import { orders } from '@shop/db/schema/order';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * The one statement behind an order reference.
 *
 * `orders_order_no_uq` makes this an index lookup, and the owner is in the
 * WHERE rather than checked afterwards, so a stranger's order number is
 * indistinguishable from one that does not exist — the same enumeration rule
 * `findOrderForUser` follows (AUTH-005).
 */
export async function findIdByOrderNoForUser(
  db: DbOrTx,
  args: { orderNo: string; userId: number },
): Promise<number | null> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.orderNo, args.orderNo),
        eq(orders.userId, args.userId),
        isNull(orders.hiddenByUserAt),
        isNull(orders.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}
