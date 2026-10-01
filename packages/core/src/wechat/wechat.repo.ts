import type { DbOrTx } from '@shop/db';
import { wechatIdentities } from '@shop/db/schema/wechat';
import { and, eq } from 'drizzle-orm';

/**
 * Reads of `wechat_identities`.
 *
 * Deliberately tiny and read-only. The table's *writes* belong to sign-in in
 * the user domain (login binds the identity); what the rest of the system needs
 * from here is one question — "which openid is this user, on this app" — which
 * the payment domain has to answer before it can create a JSAPI transaction.
 *
 * It lives in the `wechat` domain rather than in `payment` for the usual
 * reason: only a `*.repo.ts` may touch `@shop/db/schema/*`, and the table is
 * WeChat's, not payment's.
 */

export type WechatApp = 'oa' | 'mini';

/** `null` when the user has never authorised on that app. */
export async function findOpenid(
  db: DbOrTx,
  userId: number,
  platform: WechatApp,
): Promise<string | null> {
  const rows = await db
    .select({ openid: wechatIdentities.openid })
    .from(wechatIdentities)
    .where(and(eq(wechatIdentities.userId, userId), eq(wechatIdentities.platform, platform)))
    .limit(1);
  return rows[0]?.openid ?? null;
}
