import type {
  AdminForm,
  AdminListItem,
  AdminListQuery,
  AdminMutationResult,
  AdminPasswordBody,
  AdminSelfProfile,
  AdminStatusBody,
  PasswordChangeResult,
  ProfileForm,
  ProfilePasswordBody,
} from '@shop/contracts/system/schemas';
import type { Ctx } from '../kernel/context';
import { requireAdminId } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId } from '../kernel/ids';
import { createAdminSessionStore } from '../auth/admin-session.store';
import * as authAdminRepo from '../auth/admin.repo';
import { DEFAULT_BCRYPT_COST, hashPassword, verifyPassword } from '../auth/password';
import { effectivePermissions } from '../auth/rbac';
import { assertMayManageAdmin, assertRolesWithinOwnGrants } from './grant-guard';
import * as repo from './system.repo';

/**
 * Admin accounts.
 *
 * Three rules, and they are the only reason this file is longer than a CRUD
 * wrapper:
 *
 * 1. **A password change always ends every session of that account.** Bumping
 *    `password_version` alone leaves a live cookie working until something reads
 *    the database, and nothing on the hot path does — the session carries the
 *    permissions. So both: bump the version *and* drop the sessions.
 * 2. **Disabling an account ends its sessions too.** Otherwise "停用" means
 *    "cannot log in again", which is not what an operator switching off a
 *    departing colleague means by it.
 * 3. **You cannot lock everybody out.** No disabling or deleting yourself, and
 *    no removing the last enabled super admin.
 */

/**
 * bcrypt cost. Injected rather than read from the environment because
 * `packages/core` has no environment; tests lower it to 4, since pure-JS bcrypt
 * at cost 10 is ~250ms and an integration file makes dozens of hashes.
 */
let bcryptCost = DEFAULT_BCRYPT_COST;

export function configureAdminPasswords(options: { bcryptCost: number }): void {
  bcryptCost = options.bcryptCost;
}

function sessions(ctx: Ctx): ReturnType<typeof createAdminSessionStore> {
  return createAdminSessionStore({ redis: ctx.redis });
}

function toListItem(
  row: repo.AdminListRow,
  roles: Array<{ id: number; name: string }>,
): AdminListItem {
  return {
    id: toId(row.id),
    account: row.account,
    name: row.name,
    avatar: row.avatar,
    phone: row.phone,
    isSuper: row.isSuper,
    enabled: row.status === 1,
    roleIds: roles.map((r) => toId(r.id)),
    roleNames: roles.map((r) => r.name),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadListItem(ctx: Ctx, id: number): Promise<AdminListItem> {
  const row = await repo.findAdmin(ctx.db, id);
  if (!row) throw new DomainError('SYSTEM_ADMIN_NOT_FOUND');
  const roles = await repo.rolesForAdmins(ctx.db, [id]);
  return toListItem(row, roles.get(id) ?? []);
}

export async function adminList(
  ctx: Ctx,
  query: AdminListQuery,
): Promise<{ items: AdminListItem[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listAdmins(ctx.db, {
    keyword: query.keyword,
    enabled: query.enabled,
    roleId: query.roleId === undefined ? undefined : fromId(query.roleId),
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  const roles = await repo.rolesForAdmins(
    ctx.db,
    rows.map((r) => r.id),
  );
  return {
    items: rows.map((row) => toListItem(row, roles.get(row.id) ?? [])),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function adminDetail(ctx: Ctx, params: { id: string }): Promise<AdminListItem> {
  return loadListItem(ctx, fromId(params.id));
}

/** Rejects unknown role ids up front: a 422 is kinder than a foreign-key 500. */
async function assertRolesExist(ctx: Ctx, roleIds: readonly string[]): Promise<number[]> {
  const ids = roleIds.map(fromId);
  if (ids.length === 0) return [];
  const known = await repo.existingRoleIds(ctx.db, ids);
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new DomainError('SYSTEM_ROLE_UNKNOWN', { details: { roleIds: missing.map(toId) } });
  }
  return ids;
}

export async function adminCreate(ctx: Ctx, body: AdminForm): Promise<AdminMutationResult> {
  if (!body.password) throw new DomainError('SYSTEM_ADMIN_PASSWORD_REQUIRED');
  const roleIds = await assertRolesExist(ctx, body.roleIds);
  await assertRolesWithinOwnGrants(ctx, roleIds);
  if (await repo.accountTaken(ctx.db, body.account)) {
    throw new DomainError('SYSTEM_ADMIN_ACCOUNT_TAKEN');
  }

  const now = ctx.clock.now();
  const passwordHash = await hashPassword(body.password, bcryptCost);

  const id = await ctx.withTx(async (tx) => {
    // The unique index is the authority; the check above only buys a nicer message.
    let newId: number;
    try {
      newId = await repo.insertAdmin(tx, {
        account: body.account,
        name: body.name,
        passwordHash,
        phone: body.phone ?? null,
        avatar: body.avatar ?? null,
        status: body.enabled ? 1 : 0,
        now,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('SYSTEM_ADMIN_ACCOUNT_TAKEN');
      throw error;
    }
    await authAdminRepo.setAdminRoles(tx, newId, roleIds);
    return newId;
  });

  return { admin: await loadListItem(ctx, id), revokedSessions: 0 };
}

export async function adminUpdate(
  ctx: Ctx,
  params: { id: string },
  body: AdminForm,
): Promise<AdminMutationResult> {
  const id = fromId(params.id);
  const callerId = requireAdminId(ctx);
  const existing = await repo.findAdmin(ctx.db, id);
  if (!existing) throw new DomainError('SYSTEM_ADMIN_NOT_FOUND');
  await assertMayManageAdmin(ctx, existing);

  const roleIds = await assertRolesExist(ctx, body.roleIds);
  await assertRolesWithinOwnGrants(ctx, roleIds);
  if (await repo.accountTaken(ctx.db, body.account, id)) {
    throw new DomainError('SYSTEM_ADMIN_ACCOUNT_TAKEN');
  }

  const disabling = existing.status === 1 && !body.enabled;
  if (disabling) await assertMayDisable(ctx, { id, callerId, isSuper: existing.isSuper });

  const now = ctx.clock.now();
  const passwordHash = body.password ? await hashPassword(body.password, bcryptCost) : null;

  await ctx.withTx(async (tx) => {
    try {
      await repo.updateAdminProfile(
        tx,
        id,
        {
          account: body.account,
          name: body.name,
          phone: body.phone ?? null,
          avatar: body.avatar ?? null,
          status: body.enabled ? 1 : 0,
        },
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('SYSTEM_ADMIN_ACCOUNT_TAKEN');
      throw error;
    }
    await authAdminRepo.setAdminRoles(tx, id, roleIds);
    if (passwordHash) await authAdminRepo.setPassword(tx, id, { hash: passwordHash, now });
  });

  // After the commit: revoking a session for a transaction that then rolls back
  // would log somebody out for nothing.
  const revokedSessions =
    passwordHash || disabling || roleIdsChanged(existing, roleIds)
      ? await sessions(ctx).revokeAllForAdmin(id)
      : 0;

  return { admin: await loadListItem(ctx, id), revokedSessions };
}

/**
 * Role grants are cached in the session, so a grant change must end the
 * sessions that hold the stale list — otherwise removing a permission does
 * nothing until the admin happens to log out.
 */
function roleIdsChanged(_existing: repo.AdminListRow, _roleIds: readonly number[]): boolean {
  // Cheap and correct: any edit that reaches `setAdminRoles` rewrites the grant
  // set, so treat every update as a grant change rather than diffing two lists
  // and getting it subtly wrong.
  return true;
}

export async function adminSetStatus(
  ctx: Ctx,
  params: { id: string },
  body: AdminStatusBody,
): Promise<AdminMutationResult> {
  const id = fromId(params.id);
  const callerId = requireAdminId(ctx);
  const existing = await repo.findAdmin(ctx.db, id);
  if (!existing) throw new DomainError('SYSTEM_ADMIN_NOT_FOUND');
  await assertMayManageAdmin(ctx, existing);

  const to = body.enabled ? 1 : 0;
  if (!body.enabled) await assertMayDisable(ctx, { id, callerId, isSuper: existing.isSuper });

  const { won } = await repo.setAdminStatus(ctx.db, {
    id,
    from: to === 1 ? 0 : 1,
    to,
    now: ctx.clock.now(),
  });

  // Only the caller that actually flipped the row may claim the revocations.
  const revokedSessions = won && to === 0 ? await sessions(ctx).revokeAllForAdmin(id) : 0;
  return { admin: await loadListItem(ctx, id), revokedSessions };
}

export async function adminResetPassword(
  ctx: Ctx,
  params: { id: string },
  body: AdminPasswordBody,
): Promise<PasswordChangeResult> {
  const id = fromId(params.id);
  const existing = await repo.findAdmin(ctx.db, id);
  if (!existing) throw new DomainError('SYSTEM_ADMIN_NOT_FOUND');
  await assertMayManageAdmin(ctx, existing);

  const hash = await hashPassword(body.password, bcryptCost);
  await authAdminRepo.setPassword(ctx.db, id, { hash, now: ctx.clock.now() });
  const revokedSessions = await sessions(ctx).revokeAllForAdmin(id);
  ctx.logger.info({ adminId: id, revokedSessions }, 'admin password reset by operator');
  return { revokedSessions };
}

export async function adminDelete(ctx: Ctx, params: { id: string }): Promise<void> {
  const id = fromId(params.id);
  const callerId = requireAdminId(ctx);
  const existing = await repo.findAdmin(ctx.db, id);
  if (!existing) throw new DomainError('SYSTEM_ADMIN_NOT_FOUND');
  await assertMayManageAdmin(ctx, existing);
  await assertMayDisable(ctx, { id, callerId, isSuper: existing.isSuper });

  const { won } = await repo.softDeleteAdmin(ctx.db, { id, now: ctx.clock.now() });
  if (!won) throw new DomainError('SYSTEM_ADMIN_NOT_FOUND');
  await sessions(ctx).revokeAllForAdmin(id);
}

/**
 * The lock-out guard. Not a database constraint because "the last enabled super
 * admin" is a statement about a set, and the set is small enough to count.
 */
async function assertMayDisable(
  ctx: Ctx,
  args: { id: number; callerId: number; isSuper: boolean },
): Promise<void> {
  if (args.id === args.callerId) throw new DomainError('SYSTEM_ADMIN_SELF_LOCKOUT');
  if (!args.isSuper) return;
  const others = await repo.countOtherEnabledSupers(ctx.db, args.id);
  if (others === 0) throw new DomainError('SYSTEM_ADMIN_SELF_LOCKOUT');
}

// ---------------------------------------------------------------------------
// the caller's own account
// ---------------------------------------------------------------------------

export async function profileGet(ctx: Ctx): Promise<AdminSelfProfile> {
  const id = requireAdminId(ctx);
  const row = await repo.findAdmin(ctx.db, id);
  if (!row) throw new DomainError('AUTH_SESSION_EXPIRED');
  const roles = await repo.rolesForAdmins(ctx.db, [id]);
  const granted = row.isSuper ? [] : await authAdminRepo.loadPermissions(ctx.db, id);
  return {
    id: toId(row.id),
    account: row.account,
    name: row.name,
    avatar: row.avatar,
    phone: row.phone,
    isSuper: row.isSuper,
    roleNames: (roles.get(id) ?? []).map((r) => r.name),
    permissions: effectivePermissions(granted),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  };
}

export async function profileUpdate(ctx: Ctx, body: ProfileForm): Promise<AdminSelfProfile> {
  const id = requireAdminId(ctx);
  await repo.updateAdminProfile(
    ctx.db,
    id,
    { name: body.name, phone: body.phone ?? null, avatar: body.avatar ?? null },
    ctx.clock.now(),
  );
  return profileGet(ctx);
}

/**
 * Changing one's own password.
 *
 * The current password is required: an attacker holding a stolen cookie must
 * not be able to lock the real owner out of their own account with one request.
 * On success every session dies, including the caller's own — that is the
 * point, and the admin shell treats the next 401 as "please sign in again".
 */
export async function profileChangePassword(
  ctx: Ctx,
  body: ProfilePasswordBody,
): Promise<PasswordChangeResult> {
  const id = requireAdminId(ctx);
  const row = await authAdminRepo.findById(ctx.db, id);
  if (!row) throw new DomainError('AUTH_SESSION_EXPIRED');

  const verified = await verifyPassword(
    body.currentPassword,
    row.passwordHash,
    row.passwordAlgo as 'bcrypt' | 'md5',
  );
  if (!verified.ok) throw new DomainError('SYSTEM_PASSWORD_MISMATCH');

  const hash = await hashPassword(body.newPassword, bcryptCost);
  await authAdminRepo.setPassword(ctx.db, id, { hash, now: ctx.clock.now() });
  const revokedSessions = await sessions(ctx).revokeAllForAdmin(id);
  ctx.logger.info({ adminId: id, revokedSessions }, 'admin changed own password');
  return { revokedSessions };
}

/** PostgreSQL `23505`, whatever driver wrapper it arrives in. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === '23505' || causeCode === '23505';
}

export { toListItem as toAdminListItem };
