import type { DbOrTx } from '@shop/db';
import { wechatMiniCodes } from '@shop/db/schema/wechat';
import { and, eq } from 'drizzle-orm';

/**
 * The 小程序码 cache table.
 *
 * Two operations, and the interesting one is the insert: it is
 * `on conflict do nothing` followed by a re-read, because two shoppers can ask
 * for the same poster in the same millisecond. Both will have generated a PNG
 * — WeChat was called twice, which is a wasted quota unit and nothing worse —
 * and exactly one row survives. The loser reads the winner's URL rather than
 * failing, so neither shopper sees an error over a race between two identical
 * results.
 */

export interface MiniCodeRow {
  id: number;
  page: string;
  scene: string;
  storageKey: string;
  url: string;
}

export async function findByPageScene(
  db: DbOrTx,
  key: { page: string; scene: string },
): Promise<MiniCodeRow | null> {
  const rows = await db
    .select({
      id: wechatMiniCodes.id,
      page: wechatMiniCodes.page,
      scene: wechatMiniCodes.scene,
      storageKey: wechatMiniCodes.storageKey,
      url: wechatMiniCodes.url,
    })
    .from(wechatMiniCodes)
    .where(and(eq(wechatMiniCodes.page, key.page), eq(wechatMiniCodes.scene, key.scene)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Record a generated code, or keep the one that got there first.
 *
 * Returns the row that is now live and whether this call is the one that
 * created it — the caller uses that to know whether its own bytes are the ones
 * being served, and can drop the orphan it just wrote otherwise.
 */
export async function insertIgnoringConflict(
  db: DbOrTx,
  row: { page: string; scene: string; storageKey: string; url: string },
): Promise<{ row: MiniCodeRow; inserted: boolean }> {
  const inserted = await db
    .insert(wechatMiniCodes)
    .values(row)
    .onConflictDoNothing({ target: [wechatMiniCodes.page, wechatMiniCodes.scene] })
    .returning({
      id: wechatMiniCodes.id,
      page: wechatMiniCodes.page,
      scene: wechatMiniCodes.scene,
      storageKey: wechatMiniCodes.storageKey,
      url: wechatMiniCodes.url,
    });

  const won = inserted[0];
  if (won) return { row: won, inserted: true };

  const existing = await findByPageScene(db, row);
  // Unreachable in practice: the conflict says a row exists. If it somehow does
  // not (deleted between the two statements), answering with our own values is
  // correct — the bytes are stored and the URL serves them.
  return { row: existing ?? { id: 0, ...row }, inserted: false };
}
