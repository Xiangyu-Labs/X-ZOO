import type { DbOrTx } from '@shop/db';
import { adminRoles, admins, rolePermissions, roles } from '@shop/db/schema/auth';
import { and, eq, inArray, sql } from 'drizzle-orm';

/** The only file that touches `admins`, `roles`, `role_permissions`, `admin_roles`. */

export interface AdminRow {
  id: number;
  account: string;
  passwordHash: string;
  passwordAlgo: string;
  passwordVersion: number;
  name: string;
  avatar: string | null;
  isSuper: boolean;
  status: number;
}

/**
 * Case-insensitive lookup. PostgreSQL is case-sensitive where MySQL was not,
 * and `admins_account_lower_key` is the matching unique index, so this is the
 * only correct way to find an admin by login name.
 */
export async function findByAccount(db: DbOrTx, account: string): Promise<AdminRow | null> {
  const rows = await db
    .select({
      id: admins.id,
      account: admins.account,
      passwordHash: admins.passwordHash,
      passwordAlgo: admins.passwordAlgo,
      passwordVersion: admins.passwordVersion,
      name: admins.name,
      avatar: admins.avatar,
      isSuper: admins.isSuper,
      status: admins.status,
    })
    .from(admins)
    .where(and(sql`lower(${admins.account}) = lower(${account})`, sql`${admins.deletedAt} is null`))
    .limit(1);
  return rows[0] ?? null;
}

export async function findById(db: DbOrTx, id: number): Promise<AdminRow | null> {
  const rows = await db
    .select({
      id: admins.id,
      account: admins.account,
      passwordHash: admins.passwordHash,
      passwordAlgo: admins.passwordAlgo,
      passwordVersion: admins.passwordVersion,
      name: admins.name,
      avatar: admins.avatar,
      isSuper: admins.isSuper,
      status: admins.status,
    })
    .from(admins)
    .where(and(eq(admins.id, id), sql`${admins.deletedAt} is null`))
    .limit(1);
  return rows[0] ?? null;
}

/** Union of the atoms every role of this admin grants. */
export async function loadPermissions(db: DbOrTx, adminId: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ permission: rolePermissions.permission })
    .from(adminRoles)
    .innerJoin(roles, eq(roles.id, adminRoles.roleId))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(and(eq(adminRoles.adminId, adminId), eq(roles.status, 1)));
  return rows.map((r) => r.permission).sort();
}

export async function touchLastLogin(db: DbOrTx, adminId: number, at: Date): Promise<void> {
  await db.update(admins).set({ lastLoginAt: at, updatedAt: at }).where(eq(admins.id, adminId));
}

/**
 * Rewrites a legacy md5 hash as bcrypt. Guarded on the old hash so two
 * concurrent logins cannot both "upgrade" and clobber a password change that
 * landed between them.
 */
export async function upgradePasswordHash(
  db: DbOrTx,
  adminId: number,
  input: { fromHash: string; toHash: string; now: Date },
): Promise<number> {
  const result = await db
    .update(admins)
    .set({ passwordHash: input.toHash, passwordAlgo: 'bcrypt', updatedAt: input.now })
    .where(and(eq(admins.id, adminId), eq(admins.passwordHash, input.fromHash)));
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

/**
 * Sets a new password and bumps `password_version`, which is what makes every
 * existing session invalid. The caller must also call `revokeAllForAdmin`.
 */
export async function setPassword(
  db: DbOrTx,
  adminId: number,
  input: { hash: string; now: Date },
): Promise<number> {
  const result = await db
    .update(admins)
    .set({
      passwordHash: input.hash,
      passwordAlgo: 'bcrypt',
      passwordVersion: sql`${admins.passwordVersion} + 1`,
      updatedAt: input.now,
    })
    .where(eq(admins.id, adminId));
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

export async function replaceRolePermissions(
  tx: DbOrTx,
  roleId: number,
  atoms: readonly string[],
): Promise<void> {
  await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  if (atoms.length === 0) return;
  await tx
    .insert(rolePermissions)
    .values([...new Set(atoms)].map((permission) => ({ roleId, permission })))
    .onConflictDoNothing();
}

export async function setAdminRoles(
  tx: DbOrTx,
  adminId: number,
  roleIds: readonly number[],
): Promise<void> {
  await tx.delete(adminRoles).where(eq(adminRoles.adminId, adminId));
  if (roleIds.length === 0) return;
  await tx
    .insert(adminRoles)
    .values([...new Set(roleIds)].map((roleId) => ({ adminId, roleId })))
    .onConflictDoNothing();
}

export async function roleNames(db: DbOrTx, roleIds: readonly number[]): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const rows = await db
    .select({ name: roles.name })
    .from(roles)
    .where(inArray(roles.id, [...roleIds]));
  return rows.map((r) => r.name);
}
