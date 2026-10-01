import type { DbOrTx, Tx } from '@shop/db';
import { userVisits } from '@shop/db/schema/stats';
import { userAddresses } from '@shop/db/schema/user';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';

/**
 * The only writer of `user_visits` in the system.
 *
 * `stats` reads the table and is select-only on purpose: the recorder lives
 * with whoever owns the storefront session rather than with the domain that
 * aggregates it, so that `stats.repo.ts` being provably free of writes stays
 * true. The retention sweep lives here for the same reason.
 */

export interface InsertVisitInput {
  userId: number | null;
  path: string;
  platform: 'h5' | 'wechat_oa' | 'wechat_mini' | null;
  ip: string | null;
  now: Date;
}

/**
 * Records one view and returns its id, which the service keeps so the page's
 * stay can be attached to it later. Nothing else reads the row back.
 *
 * `province` is the signed-in visitor's default address, looked up in the same
 * statement through `user_addresses_default_uq` — the same notion of "where a
 * user is" that the 地域分布 user columns use. An anonymous visit, or a user
 * with no default address, stays null and is counted under 未知: guessing a
 * province would make 地域访客 confidently wrong rather than honestly partial.
 */
export async function insertVisit(db: DbOrTx, input: InsertVisitInput): Promise<number> {
  const province =
    input.userId === null
      ? null
      : sql<string | null>`(
          select ${userAddresses.provinceName}
            from ${userAddresses}
           where ${userAddresses.userId} = ${input.userId}
             and ${userAddresses.isDefault}
             and ${userAddresses.deletedAt} is null
           limit 1
        )`;
  const [row] = await db
    .insert(userVisits)
    .values({
      userId: input.userId,
      path: input.path,
      platform: input.platform,
      ip: input.ip,
      province,
      stayMs: null,
      createdAt: input.now,
    })
    .returning({ id: userVisits.id });
  return row!.id;
}

/**
 * Credits a view with `stayMs` more milliseconds on screen.
 *
 * Added, not replaced: a page the visitor left and came back to inside the
 * one-minute throttle is still one view, and its time on screen is the sum of
 * both spells. The total is capped twice — at `capMs`, and at the time since
 * the view was recorded — so no report, however large or however often sent,
 * can credit a view with more time than has actually passed.
 */
export async function addStay(
  db: DbOrTx,
  input: { id: number; stayMs: number; capMs: number; now: Date },
): Promise<void> {
  const elapsedMs = sql`greatest(0, floor(extract(epoch from (${input.now.toISOString()}::timestamptz - ${userVisits.createdAt})) * 1000))`;
  await db
    .update(userVisits)
    .set({
      stayMs: sql`least(coalesce(${userVisits.stayMs}, 0) + ${input.stayMs}, ${input.capMs}, ${elapsedMs})::int`,
    })
    .where(eq(userVisits.id, input.id));
}

/**
 * The retention sweep: deletes up to `limit` views recorded before `before`,
 * oldest first, so a long-neglected table drains over several runs instead of
 * holding one transaction over millions of rows. Walks
 * `user_visits_created_at_idx`.
 */
export async function pruneVisits(tx: Tx, args: { before: Date; limit: number }): Promise<number> {
  const due = await tx
    .select({ id: userVisits.id })
    .from(userVisits)
    .where(lt(userVisits.createdAt, args.before))
    .orderBy(asc(userVisits.createdAt))
    .limit(args.limit);
  if (due.length === 0) return 0;
  const deleted = await tx
    .delete(userVisits)
    .where(
      and(
        inArray(
          userVisits.id,
          due.map((row) => row.id),
        ),
        lt(userVisits.createdAt, args.before),
      ),
    )
    .returning({ id: userVisits.id });
  return deleted.length;
}
