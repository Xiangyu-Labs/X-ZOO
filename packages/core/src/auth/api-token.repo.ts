import type { DbOrTx } from '@shop/db';
import { adminApiTokens, admins, oauthClients } from '@shop/db/schema/auth';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';

/** The only file that touches `admin_api_tokens` and `oauth_clients`. */

export type ApiTokenKind = 'pat' | 'oauth';

export interface ApiTokenRow {
  id: number;
  adminId: number;
  adminAccount: string;
  name: string;
  kind: ApiTokenKind;
  hint: string;
  clientId: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** What the request path needs: the token and the admin it acts as, in one read. */
export interface LiveTokenRow {
  id: number;
  name: string;
  adminId: number;
  account: string;
  isSuper: boolean;
  lastUsedAt: Date | null;
}

const listColumns = {
  id: adminApiTokens.id,
  adminId: adminApiTokens.adminId,
  adminAccount: admins.account,
  name: adminApiTokens.name,
  kind: adminApiTokens.kind,
  hint: adminApiTokens.hint,
  clientId: adminApiTokens.clientId,
  expiresAt: adminApiTokens.expiresAt,
  lastUsedAt: adminApiTokens.lastUsedAt,
  lastUsedIp: adminApiTokens.lastUsedIp,
  revokedAt: adminApiTokens.revokedAt,
  createdAt: adminApiTokens.createdAt,
};

export async function insert(
  db: DbOrTx,
  input: {
    adminId: number;
    name: string;
    kind: ApiTokenKind;
    tokenHash: string;
    hint: string;
    refreshHash: string | null;
    clientId: string | null;
    passwordVersion: number;
    expiresAt: Date | null;
    refreshExpiresAt: Date | null;
    now: Date;
  },
): Promise<number> {
  const rows = await db
    .insert(adminApiTokens)
    .values({ ...input, createdAt: input.now })
    .returning({ id: adminApiTokens.id });
  const row = rows[0];
  if (!row) throw new Error('admin_api_tokens: insert returned no row');
  return row.id;
}

/**
 * A token that may act right now: not revoked, not expired, its admin live
 * and enabled, and minted under the admin's current password.
 */
export async function findLive(
  db: DbOrTx,
  tokenHash: string,
  now: Date,
): Promise<LiveTokenRow | null> {
  const rows = await db
    .select({
      id: adminApiTokens.id,
      name: adminApiTokens.name,
      adminId: admins.id,
      account: admins.account,
      isSuper: admins.isSuper,
      lastUsedAt: adminApiTokens.lastUsedAt,
    })
    .from(adminApiTokens)
    .innerJoin(admins, eq(admins.id, adminApiTokens.adminId))
    .where(
      and(
        eq(adminApiTokens.tokenHash, tokenHash),
        isNull(adminApiTokens.revokedAt),
        or(isNull(adminApiTokens.expiresAt), sql`${adminApiTokens.expiresAt} > ${now}`),
        eq(admins.status, 1),
        isNull(admins.deletedAt),
        eq(admins.passwordVersion, adminApiTokens.passwordVersion),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** The live OAuth grant a refresh token belongs to, with its admin's password version. */
export async function findByRefresh(
  db: DbOrTx,
  refreshHash: string,
  now: Date,
): Promise<{ id: number; adminId: number; clientId: string | null; name: string } | null> {
  const rows = await db
    .select({
      id: adminApiTokens.id,
      adminId: adminApiTokens.adminId,
      clientId: adminApiTokens.clientId,
      name: adminApiTokens.name,
    })
    .from(adminApiTokens)
    .innerJoin(admins, eq(admins.id, adminApiTokens.adminId))
    .where(
      and(
        eq(adminApiTokens.refreshHash, refreshHash),
        eq(adminApiTokens.kind, 'oauth'),
        isNull(adminApiTokens.revokedAt),
        sql`${adminApiTokens.refreshExpiresAt} > ${now}`,
        eq(admins.status, 1),
        isNull(admins.deletedAt),
        eq(admins.passwordVersion, adminApiTokens.passwordVersion),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Swaps both secrets of a grant. Conditional on the old refresh hash, so two
 * refreshes racing with one refresh token cannot both win.
 */
export async function rotate(
  db: DbOrTx,
  id: number,
  input: {
    fromRefreshHash: string;
    tokenHash: string;
    hint: string;
    refreshHash: string;
    expiresAt: Date;
    refreshExpiresAt: Date;
  },
): Promise<boolean> {
  const result = await db
    .update(adminApiTokens)
    .set({
      tokenHash: input.tokenHash,
      hint: input.hint,
      refreshHash: input.refreshHash,
      expiresAt: input.expiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
    })
    .where(
      and(
        eq(adminApiTokens.id, id),
        eq(adminApiTokens.refreshHash, input.fromRefreshHash),
        isNull(adminApiTokens.revokedAt),
      ),
    );
  return ((result as { rowCount?: number | null }).rowCount ?? 0) > 0;
}

/** At most one write a minute per token: this runs on every agent request. */
export async function touch(db: DbOrTx, id: number, ip: string | null, now: Date): Promise<void> {
  await db
    .update(adminApiTokens)
    .set({ lastUsedAt: now, lastUsedIp: ip })
    .where(
      and(
        eq(adminApiTokens.id, id),
        or(
          isNull(adminApiTokens.lastUsedAt),
          sql`${adminApiTokens.lastUsedAt} < ${new Date(now.getTime() - 60_000)}`,
        ),
      ),
    );
}

/** Live and revoked alike, newest first; `adminId` narrows to one admin. */
export async function list(db: DbOrTx, adminId: number | null): Promise<ApiTokenRow[]> {
  const rows = await db
    .select(listColumns)
    .from(adminApiTokens)
    .innerJoin(admins, eq(admins.id, adminApiTokens.adminId))
    .where(adminId === null ? undefined : eq(adminApiTokens.adminId, adminId))
    .orderBy(desc(adminApiTokens.id))
    .limit(200);
  return rows as ApiTokenRow[];
}

export async function findById(db: DbOrTx, id: number): Promise<ApiTokenRow | null> {
  const rows = await db
    .select(listColumns)
    .from(adminApiTokens)
    .innerJoin(admins, eq(admins.id, adminApiTokens.adminId))
    .where(eq(adminApiTokens.id, id))
    .limit(1);
  return (rows[0] as ApiTokenRow | undefined) ?? null;
}

export async function revoke(db: DbOrTx, id: number, now: Date): Promise<boolean> {
  const result = await db
    .update(adminApiTokens)
    .set({ revokedAt: now, refreshHash: null })
    .where(and(eq(adminApiTokens.id, id), isNull(adminApiTokens.revokedAt)));
  return ((result as { rowCount?: number | null }).rowCount ?? 0) > 0;
}

// -- OAuth clients -------------------------------------------------------------

export interface OAuthClientRow {
  clientId: string;
  name: string;
  redirectUris: string[];
}

export async function insertClient(
  db: DbOrTx,
  input: OAuthClientRow & { now: Date },
): Promise<void> {
  await db.insert(oauthClients).values({
    clientId: input.clientId,
    name: input.name,
    redirectUris: input.redirectUris,
    createdAt: input.now,
  });
}

export async function findClient(db: DbOrTx, clientId: string): Promise<OAuthClientRow | null> {
  const rows = await db
    .select({
      clientId: oauthClients.clientId,
      name: oauthClients.name,
      redirectUris: oauthClients.redirectUris,
    })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}
