import type { DbOrTx, Tx } from '@shop/db';
import { cartItems } from '@shop/db/schema/cart';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { conditionalDelete, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';

/**
 * Every `cart_items` statement, and nothing else.
 *
 * The one to read is `addUnits`. Reading the row, deciding, and then inserting
 * or updating would let one shopper tapping 加入购物车 on two devices produce
 * two rows for the same variant. Here it is a single
 * `INSERT … ON CONFLICT (user_id, sku_id) DO UPDATE`, so the database decides
 * and the answer comes back in the same round trip.
 */

export type CartRow = typeof cartItems.$inferSelect;

/**
 * The whole cart, oldest row last. Carts are small — the storefront caps the
 * page at 200 and nobody has thousands of rows — so availability is worked out
 * in the service over the complete list rather than with a join the catalogue
 * domain would have to own.
 */
export async function listByUser(
  db: DbOrTx,
  args: { userId: number; limit: number },
): Promise<CartRow[]> {
  return db
    .select()
    .from(cartItems)
    .where(eq(cartItems.userId, args.userId))
    .orderBy(asc(cartItems.id))
    .limit(args.limit);
}

export async function findForUser(
  db: DbOrTx,
  args: { id: number; userId: number },
): Promise<CartRow | null> {
  const rows = await db
    .select()
    .from(cartItems)
    .where(and(eq(cartItems.id, args.id), eq(cartItems.userId, args.userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findBySku(
  db: DbOrTx,
  args: { userId: number; skuId: number },
): Promise<CartRow | null> {
  const rows = await db
    .select()
    .from(cartItems)
    .where(and(eq(cartItems.userId, args.userId), eq(cartItems.skuId, args.skuId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Adds `quantity` units, creating the row if it is not there yet, and returns
 * the row as it now stands. One statement: two concurrent adds of the same
 * variant end at the sum, never at two rows and never at a lost update.
 *
 * `cap` stops a repeated tap running past what the schema and the UI allow;
 * clamping in SQL keeps it inside the same statement.
 */
export async function addUnits(
  tx: Tx,
  args: { userId: number; productId: number; skuId: number; quantity: number; cap: number },
): Promise<CartRow> {
  const rows = await tx
    .insert(cartItems)
    .values({
      userId: args.userId,
      productId: args.productId,
      skuId: args.skuId,
      quantity: args.quantity,
      isSelected: true,
    })
    .onConflictDoUpdate({
      target: [cartItems.userId, cartItems.skuId],
      set: {
        quantity: sql`least(${cartItems.quantity} + ${args.quantity}, ${args.cap})`,
        // Adding a variant again re-ticks it: the shopper just said they want it.
        isSelected: true,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return rows[0]!;
}

/** Absolute quantity. The guard keeps a stale client from resurrecting a deleted row. */
export async function setQuantity(
  tx: Tx,
  args: { id: number; userId: number; quantity: number },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, cartItems, {
    where: and(eq(cartItems.id, args.id), eq(cartItems.userId, args.userId)),
    set: { quantity: args.quantity, updatedAt: sql`now()` },
  });
}

export async function setSelected(
  tx: Tx,
  args: { userId: number; ids: readonly number[]; isSelected: boolean },
): Promise<ConditionalUpdateResult> {
  if (args.ids.length === 0) return { affected: 0, won: false };
  return conditionalUpdate(tx, cartItems, {
    where: and(eq(cartItems.userId, args.userId), inArray(cartItems.id, [...new Set(args.ids)])),
    set: { isSelected: args.isSelected, updatedAt: sql`now()` },
  });
}

export async function remove(
  tx: Tx,
  args: { userId: number; ids: readonly number[] },
): Promise<number> {
  if (args.ids.length === 0) return 0;
  const { affected } = await conditionalDelete(
    tx,
    cartItems,
    and(eq(cartItems.userId, args.userId), inArray(cartItems.id, [...new Set(args.ids)])),
  );
  return affected;
}

/**
 * Removes one row by id, reporting whether this call is the one that did it.
 *
 * 修改规格 needs the distinction that `remove` above throws away: the row is
 * deleted and its units are re-added under the new variant, so a caller that
 * lost the race must not add them a second time.
 */
export async function removeOne(
  tx: Tx,
  args: { id: number; userId: number },
): Promise<ConditionalUpdateResult> {
  return conditionalDelete(
    tx,
    cartItems,
    and(eq(cartItems.id, args.id), eq(cartItems.userId, args.userId)),
  );
}
