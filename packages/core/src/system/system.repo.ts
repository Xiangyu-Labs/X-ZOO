import type { DbOrTx, Tx } from '@shop/db';
import {
  adminApiTokens,
  adminRoles,
  admins,
  auditLogs,
  rolePermissions,
  roles,
} from '@shop/db/schema/auth';
import { configValues } from '@shop/db/schema/system';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { containsPattern } from '../kernel/like';
import { allOf, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';

/**
 * The only file in the `system` domain that touches Drizzle tables.
 *
 * It reaches `admins` / `roles` / `role_permissions` / `admin_roles`, which
 * `auth/admin.repo.ts` also reads. That is deliberate and not a layering
 * accident: `auth` owns *authentication* (find by account, verify, upgrade a
 * hash) and `system` owns *administration* (list, create, disable, delete). The
 * two never write the same columns except `password_hash`, and that one goes
 * through `auth`'s service so the session revocation happens with it.
 *
 * Statements, not decisions: nothing here throws a `DomainError`.
 */

// ---------------------------------------------------------------------------
// admins
// ---------------------------------------------------------------------------

export interface AdminListRow {
  id: number;
  account: string;
  name: string;
  avatar: string | null;
  phone: string | null;
  isSuper: boolean;
  status: number;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const ADMIN_COLUMNS = {
  id: admins.id,
  account: admins.account,
  name: admins.name,
  avatar: admins.avatar,
  phone: admins.phone,
  isSuper: admins.isSuper,
  status: admins.status,
  lastLoginAt: admins.lastLoginAt,
  createdAt: admins.createdAt,
} as const;

const ADMIN_ALIVE = sql`${admins.deletedAt} is null`;

export interface AdminListArgs {
  keyword?: string | undefined;
  enabled?: boolean | undefined;
  roleId?: number | undefined;
  sortBy?: 'id' | 'createdAt' | 'lastLoginAt' | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  limit: number;
  offset: number;
}

function adminFilters(args: AdminListArgs): SQL | undefined {
  return allOf(
    ADMIN_ALIVE,
    args.keyword
      ? or(
          ilike(admins.account, containsPattern(args.keyword)),
          ilike(admins.name, containsPattern(args.keyword)),
        )
      : undefined,
    args.enabled === undefined ? undefined : eq(admins.status, args.enabled ? 1 : 0),
    args.roleId === undefined
      ? undefined
      : sql`exists (select 1 from ${adminRoles} ar where ar.admin_id = ${admins.id} and ar.role_id = ${args.roleId})`,
  );
}

export async function listAdmins(
  db: DbOrTx,
  args: AdminListArgs,
): Promise<{ rows: AdminListRow[]; total: number }> {
  const where = adminFilters(args);
  const column =
    args.sortBy === 'createdAt'
      ? admins.createdAt
      : args.sortBy === 'lastLoginAt'
        ? admins.lastLoginAt
        : admins.id;
  const direction = args.sortOrder === 'asc' ? asc : desc;

  const rows = await db
    .select(ADMIN_COLUMNS)
    .from(admins)
    .where(where)
    .orderBy(direction(column), desc(admins.id))
    .limit(args.limit)
    .offset(args.offset);

  const totals = await db.select({ value: count() }).from(admins).where(where);
  return { rows, total: Number(totals[0]?.value ?? 0) };
}

export async function findAdmin(db: DbOrTx, id: number): Promise<AdminListRow | null> {
  const rows = await db
    .select(ADMIN_COLUMNS)
    .from(admins)
    .where(and(eq(admins.id, id), ADMIN_ALIVE))
    .limit(1);
  return rows[0] ?? null;
}

/** Case-insensitive, matching `admins_account_lower_key`. Excludes one id on edit. */
export async function accountTaken(
  db: DbOrTx,
  account: string,
  exceptId?: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: admins.id })
    .from(admins)
    .where(
      allOf(
        sql`lower(${admins.account}) = lower(${account})`,
        exceptId === undefined ? undefined : sql`${admins.id} <> ${exceptId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface InsertAdminArgs {
  account: string;
  name: string;
  passwordHash: string;
  phone: string | null;
  avatar: string | null;
  status: number;
  now: Date;
}

export async function insertAdmin(tx: Tx, args: InsertAdminArgs): Promise<number> {
  const rows = await tx
    .insert(admins)
    .values({
      account: args.account,
      name: args.name,
      passwordHash: args.passwordHash,
      passwordAlgo: 'bcrypt',
      phone: args.phone,
      avatar: args.avatar,
      status: args.status,
      isSuper: false,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .returning({ id: admins.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('system.repo: insertAdmin 未返回主键');
  return id;
}

export async function updateAdminProfile(
  tx: DbOrTx,
  id: number,
  patch: {
    account?: string;
    name?: string;
    phone?: string | null;
    avatar?: string | null;
    status?: number;
  },
  now: Date,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, admins, {
    where: and(eq(admins.id, id), ADMIN_ALIVE),
    set: { ...patch, updatedAt: now },
  });
}

/**
 * Disabling an account, guarded on its current status.
 *
 * The guard is the point: two operators toggling at once must not both come
 * away believing they made the change, and `revokedSessions` in the response is
 * only truthful for the one that actually flipped the row.
 */
export async function setAdminStatus(
  tx: DbOrTx,
  args: { id: number; from: number; to: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, admins, {
    where: and(eq(admins.id, args.id), eq(admins.status, args.from), ADMIN_ALIVE),
    set: { status: args.to, updatedAt: args.now },
  });
}

/**
 * Soft delete. The row stays so `audit_logs.admin_id` keeps pointing at a real
 * account, and the login name is freed by prefixing it — a deleted `operator`
 * becomes `operator#deleted:41`, which the unique index accepts and no human
 * can type by accident.
 */
export async function softDeleteAdmin(
  tx: DbOrTx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, admins, {
    where: and(eq(admins.id, args.id), ADMIN_ALIVE),
    set: {
      deletedAt: args.now,
      status: 0,
      account: sql`${admins.account} || '#deleted:' || ${admins.id}`,
      updatedAt: args.now,
    },
  });
}

/** How many enabled super admins are left, excluding one id. The lock-out guard. */
export async function countOtherEnabledSupers(db: DbOrTx, exceptId: number): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(admins)
    .where(
      and(
        eq(admins.isSuper, true),
        eq(admins.status, 1),
        ADMIN_ALIVE,
        sql`${admins.id} <> ${exceptId}`,
      ),
    );
  return Number(rows[0]?.value ?? 0);
}

/** Role ids per admin, for the list screen. One query, not N. */
export async function rolesForAdmins(
  db: DbOrTx,
  adminIds: readonly number[],
): Promise<Map<number, Array<{ id: number; name: string }>>> {
  const out = new Map<number, Array<{ id: number; name: string }>>();
  if (adminIds.length === 0) return out;
  const rows = await db
    .select({ adminId: adminRoles.adminId, id: roles.id, name: roles.name })
    .from(adminRoles)
    .innerJoin(roles, eq(roles.id, adminRoles.roleId))
    .where(inArray(adminRoles.adminId, [...adminIds]))
    .orderBy(asc(roles.id));
  for (const row of rows) {
    const list = out.get(row.adminId) ?? [];
    list.push({ id: row.id, name: row.name });
    out.set(row.adminId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

export interface RoleRow {
  id: number;
  name: string;
  remark: string | null;
  status: number;
  createdAt: Date;
}

const ROLE_COLUMNS = {
  id: roles.id,
  name: roles.name,
  remark: roles.remark,
  status: roles.status,
  createdAt: roles.createdAt,
} as const;

export interface RoleListArgs {
  keyword?: string | undefined;
  enabled?: boolean | undefined;
  sortBy?: 'id' | 'name' | 'createdAt' | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  limit: number;
  offset: number;
}

export async function listRoles(
  db: DbOrTx,
  args: RoleListArgs,
): Promise<{ rows: RoleRow[]; total: number }> {
  const where = allOf(
    args.keyword ? ilike(roles.name, containsPattern(args.keyword)) : undefined,
    args.enabled === undefined ? undefined : eq(roles.status, args.enabled ? 1 : 0),
  );
  const column =
    args.sortBy === 'name' ? roles.name : args.sortBy === 'createdAt' ? roles.createdAt : roles.id;
  const direction = args.sortOrder === 'asc' ? asc : desc;

  const rows = await db
    .select(ROLE_COLUMNS)
    .from(roles)
    .where(where)
    .orderBy(direction(column), desc(roles.id))
    .limit(args.limit)
    .offset(args.offset);
  const totals = await db.select({ value: count() }).from(roles).where(where);
  return { rows, total: Number(totals[0]?.value ?? 0) };
}

export async function findRole(db: DbOrTx, id: number): Promise<RoleRow | null> {
  const rows = await db.select(ROLE_COLUMNS).from(roles).where(eq(roles.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function roleNameTaken(db: DbOrTx, name: string, exceptId?: number): Promise<boolean> {
  const rows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(
      allOf(
        eq(roles.name, name),
        exceptId === undefined ? undefined : sql`${roles.id} <> ${exceptId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function insertRole(
  tx: Tx,
  args: { name: string; remark: string | null; status: number; now: Date },
): Promise<number> {
  const rows = await tx
    .insert(roles)
    .values({
      name: args.name,
      remark: args.remark,
      status: args.status,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .returning({ id: roles.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('system.repo: insertRole 未返回主键');
  return id;
}

export async function updateRole(
  tx: DbOrTx,
  id: number,
  patch: { name?: string; remark?: string | null; status?: number },
  now: Date,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, roles, {
    where: eq(roles.id, id),
    set: { ...patch, updatedAt: now },
  });
}

export async function setRoleStatus(
  tx: DbOrTx,
  args: { id: number; from: number; to: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, roles, {
    where: and(eq(roles.id, args.id), eq(roles.status, args.from)),
    set: { status: args.to, updatedAt: args.now },
  });
}

/** Hard delete; `role_permissions` and `admin_roles` cascade. Guarded on "unused". */
export async function deleteRoleIfUnused(tx: DbOrTx, id: number): Promise<ConditionalUpdateResult> {
  const result = await tx
    .delete(roles)
    .where(
      and(
        eq(roles.id, id),
        sql`not exists (select 1 from ${adminRoles} ar where ar.role_id = ${id})`,
      ),
    );
  const affected = (result as { rowCount?: number | null }).rowCount ?? 0;
  return { affected, won: affected > 0 };
}

export async function permissionsOfRole(db: DbOrTx, roleId: number): Promise<string[]> {
  const rows = await db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId))
    .orderBy(asc(rolePermissions.permission));
  return rows.map((r) => r.permission);
}

export async function permissionCounts(
  db: DbOrTx,
  roleIds: readonly number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (roleIds.length === 0) return out;
  const rows = await db
    .select({ roleId: rolePermissions.roleId, value: count() })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, [...roleIds]))
    .groupBy(rolePermissions.roleId);
  for (const row of rows) out.set(row.roleId, Number(row.value));
  return out;
}

export async function adminCounts(
  db: DbOrTx,
  roleIds: readonly number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (roleIds.length === 0) return out;
  const rows = await db
    .select({ roleId: adminRoles.roleId, value: count() })
    .from(adminRoles)
    .where(inArray(adminRoles.roleId, [...roleIds]))
    .groupBy(adminRoles.roleId);
  for (const row of rows) out.set(row.roleId, Number(row.value));
  return out;
}

export async function existingRoleIds(
  db: DbOrTx,
  roleIds: readonly number[],
): Promise<Set<number>> {
  if (roleIds.length === 0) return new Set();
  const rows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(inArray(roles.id, [...roleIds]));
  return new Set(rows.map((r) => r.id));
}

/**
 * Every atom the given roles grant, enabled or not: a disabled role is one
 * switch away from granting all of it.
 */
export async function permissionsOfRoles(
  db: DbOrTx,
  roleIds: readonly number[],
): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, [...roleIds]));
  return rows.map((r) => r.permission);
}

/** The role ids an admin holds, enabled or not. */
export async function roleIdsOfAdmin(db: DbOrTx, adminId: number): Promise<number[]> {
  const rows = await db
    .select({ roleId: adminRoles.roleId })
    .from(adminRoles)
    .where(eq(adminRoles.adminId, adminId));
  return rows.map((r) => r.roleId);
}

/** Admin ids that still hold a role. Used to invalidate their sessions on a grant change. */
export async function adminIdsWithRole(db: DbOrTx, roleId: number): Promise<number[]> {
  const rows = await db
    .select({ adminId: adminRoles.adminId })
    .from(adminRoles)
    .where(eq(adminRoles.roleId, roleId));
  return rows.map((r) => r.adminId);
}

// ---------------------------------------------------------------------------
// audit log
// ---------------------------------------------------------------------------

export interface AuditRow {
  id: number;
  actorKind: string;
  adminId: number | null;
  userId: number | null;
  adminAccount: string;
  routeId: string;
  method: string;
  path: string;
  target: string | null;
  status: number;
  payload: string | null;
  requestId: string;
  ip: string | null;
  /** Set when the write came through an API token (an AI assistant, the CLI). */
  apiTokenId: number | null;
  apiTokenName: string | null;
  createdAt: Date;
}

export interface AuditListArgs {
  actorKind?: 'admin' | 'staff' | undefined;
  adminId?: number | undefined;
  userId?: number | undefined;
  keyword?: string | undefined;
  routeId?: string | undefined;
  method?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  limit: number;
  offset: number;
}

export async function listAuditLogs(
  db: DbOrTx,
  args: AuditListArgs,
): Promise<{ rows: AuditRow[]; total: number }> {
  const where = allOf(
    args.actorKind ? eq(auditLogs.actorKind, args.actorKind) : undefined,
    args.adminId === undefined ? undefined : eq(auditLogs.adminId, args.adminId),
    args.userId === undefined ? undefined : eq(auditLogs.userId, args.userId),
    args.routeId ? eq(auditLogs.routeId, args.routeId) : undefined,
    args.method ? eq(auditLogs.method, args.method) : undefined,
    args.from ? gte(auditLogs.createdAt, args.from) : undefined,
    args.to ? lte(auditLogs.createdAt, args.to) : undefined,
    args.keyword
      ? or(
          ilike(auditLogs.routeId, containsPattern(args.keyword)),
          ilike(auditLogs.path, containsPattern(args.keyword)),
          ilike(auditLogs.target, containsPattern(args.keyword)),
        )
      : undefined,
  );
  const direction = args.sortOrder === 'asc' ? asc : desc;

  const rows = await db
    .select({ ...getTableColumns(auditLogs), apiTokenName: adminApiTokens.name })
    .from(auditLogs)
    .leftJoin(adminApiTokens, eq(adminApiTokens.id, auditLogs.apiTokenId))
    .where(where)
    .orderBy(direction(auditLogs.createdAt), direction(auditLogs.id))
    .limit(args.limit)
    .offset(args.offset);
  const totals = await db.select({ value: count() }).from(auditLogs).where(where);
  return { rows, total: Number(totals[0]?.value ?? 0) };
}

/** Deletes rows older than `before`, in bounded batches. Returns how many went. */
export async function pruneAuditLogs(db: DbOrTx, before: Date, limit: number): Promise<number> {
  const result = await db.execute(
    sql`delete from ${auditLogs} where ${auditLogs.id} in (
          select id from ${auditLogs} where ${auditLogs.createdAt} < ${before}
          order by id limit ${limit}
        )`,
  );
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// config metadata
// ---------------------------------------------------------------------------

/** When a group was last written, for the settings screen's "last saved" line. */
export async function configGroupUpdatedAt(db: DbOrTx, group: string): Promise<Date | null> {
  const rows = await db
    .select({ updatedAt: configValues.updatedAt })
    .from(configValues)
    .where(eq(configValues.group, group))
    .orderBy(desc(configValues.updatedAt))
    .limit(1);
  return rows[0]?.updatedAt ?? null;
}

export async function countAdmins(db: DbOrTx): Promise<number> {
  const rows = await db.select({ value: count() }).from(admins).where(ADMIN_ALIVE);
  return Number(rows[0]?.value ?? 0);
}
