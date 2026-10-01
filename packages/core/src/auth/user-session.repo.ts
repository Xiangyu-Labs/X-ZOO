import type { DbOrTx } from '@shop/db';
import { userSessions } from '@shop/db/schema/auth';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

/** The only file that touches `user_sessions`. */

export interface UserSessionRow {
  id: number;
  userId: number;
  passwordVersion: number;
  platform: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export async function insert(
  db: DbOrTx,
  input: {
    userId: number;
    tokenHash: string;
    passwordVersion: number;
    platform: string;
    userAgent: string | null;
    expiresAt: Date;
    now: Date;
  },
): Promise<number> {
  const rows = await db
    .insert(userSessions)
    .values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      passwordVersion: input.passwordVersion,
      platform: input.platform,
      userAgent: input.userAgent,
      expiresAt: input.expiresAt,
      createdAt: input.now,
    })
    .returning({ id: userSessions.id });
  const row = rows[0];
  if (!row) throw new Error('user_sessions: insert returned no row');
  return row.id;
}

export async function findLive(
  db: DbOrTx,
  tokenHash: string,
  now: Date,
): Promise<UserSessionRow | null> {
  const rows = await db
    .select({
      id: userSessions.id,
      userId: userSessions.userId,
      passwordVersion: userSessions.passwordVersion,
      platform: userSessions.platform,
      expiresAt: userSessions.expiresAt,
      revokedAt: userSessions.revokedAt,
    })
    .from(userSessions)
    .where(
      and(
        eq(userSessions.tokenHash, tokenHash),
        isNull(userSessions.revokedAt),
        sql`${userSessions.expiresAt} > ${now}`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function touch(db: DbOrTx, id: number, now: Date): Promise<void> {
  await db.update(userSessions).set({ lastSeenAt: now }).where(eq(userSessions.id, id));
}

export async function revokeByHash(db: DbOrTx, tokenHash: string, now: Date): Promise<number> {
  const result = await db
    .update(userSessions)
    .set({ revokedAt: now })
    .where(and(eq(userSessions.tokenHash, tokenHash), isNull(userSessions.revokedAt)));
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

/** "Change password logs you out everywhere." */
export async function revokeAllForUser(db: DbOrTx, userId: number, now: Date): Promise<number> {
  const result = await db
    .update(userSessions)
    .set({ revokedAt: now })
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

/** Housekeeping job: expired rows are useless once nobody can present them. */
export async function deleteExpired(db: DbOrTx, before: Date): Promise<number> {
  const result = await db.delete(userSessions).where(lt(userSessions.expiresAt, before));
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}
