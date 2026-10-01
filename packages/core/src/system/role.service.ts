import type {
  PermissionTree,
  RoleDetail,
  RoleForm,
  RoleListItem,
  RoleListQuery,
  RoleStatusBody,
} from '@shop/contracts/system/schemas';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId } from '../kernel/ids';
import { createAdminSessionStore } from '../auth/admin-session.store';
import * as authAdminRepo from '../auth/admin.repo';
import { allPermissionAtoms, isKnownPermission } from '../auth/permissions';
import { IMPLICIT_ADMIN_PERMISSIONS } from '../auth/rbac';
import { assertWithinOwnGrants } from './grant-guard';
import { requirementsOf, withRequirements } from './permission-requirements';
import * as repo from './system.repo';

/**
 * Roles, and the permission tree the role editor renders.
 *
 * **The tree comes from the code, never from a table.** `definePermissions` in
 * each domain fills a registry at import time, and this is the only thing that
 * reads it out. The old `system_menus` table could hold a permission the code
 * never checked (and did), which is how a role could look right and grant
 * nothing; here an atom that is not declared cannot be granted, and one that is
 * granted but no longer declared is reported back as `unknownPermissions` so an
 * operator can clear it.
 *
 * **A role is saved with what its editors read** (`permission-requirements.ts`):
 * ticking 商品编辑 also ticks 商品分类, 素材 and the rest the editor loads.
 *
 * **Changing a role's grants ends the sessions of everybody holding it.**
 * Permissions are cached in the session, so without that, removing an atom
 * would take effect whenever the person next happened to log out — which is the
 * opposite of what an operator revoking access means.
 */

function toListItem(row: repo.RoleRow, adminCount: number, permissionCount: number): RoleListItem {
  return {
    id: toId(row.id),
    name: row.name,
    remark: row.remark,
    enabled: row.status === 1,
    adminCount,
    permissionCount,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadDetail(ctx: Ctx, id: number): Promise<RoleDetail> {
  const row = await repo.findRole(ctx.db, id);
  if (!row) throw new DomainError('SYSTEM_ROLE_NOT_FOUND');
  const permissions = await repo.permissionsOfRole(ctx.db, id);
  const admins = await repo.adminCounts(ctx.db, [id]);
  return {
    ...toListItem(row, admins.get(id) ?? 0, permissions.length),
    permissions,
    unknownPermissions: permissions.filter((atom) => !isKnownPermission(atom)),
  };
}

export async function roleList(
  ctx: Ctx,
  query: RoleListQuery,
): Promise<{ items: RoleListItem[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listRoles(ctx.db, {
    keyword: query.keyword,
    enabled: query.enabled,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  const ids = rows.map((r) => r.id);
  const [admins, permissions] = await Promise.all([
    repo.adminCounts(ctx.db, ids),
    repo.permissionCounts(ctx.db, ids),
  ]);
  return {
    items: rows.map((row) =>
      toListItem(row, admins.get(row.id) ?? 0, permissions.get(row.id) ?? 0),
    ),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function roleDetail(ctx: Ctx, params: { id: string }): Promise<RoleDetail> {
  return loadDetail(ctx, fromId(params.id));
}

/**
 * Refuses an atom the code does not declare.
 *
 * Atoms are compiled in, so this can only be a stale browser tab or a
 * hand-written request. Storing one would create a grant that silently does
 * nothing, which is precisely the failure mode this design exists to remove.
 */
function assertPermissionsKnown(permissions: readonly string[]): void {
  const unknown = permissions.filter((atom) => !isKnownPermission(atom));
  if (unknown.length > 0) {
    throw new DomainError('SYSTEM_PERMISSION_UNKNOWN', { details: { permissions: unknown } });
  }
}

export async function roleCreate(ctx: Ctx, form: RoleForm): Promise<RoleDetail> {
  const body = { ...form, permissions: withRequirements(form.permissions) };
  assertPermissionsKnown(body.permissions);
  assertWithinOwnGrants(ctx, body.permissions);
  if (await repo.roleNameTaken(ctx.db, body.name)) {
    throw new DomainError('SYSTEM_ROLE_NAME_TAKEN');
  }
  const now = ctx.clock.now();
  const id = await ctx.withTx(async (tx) => {
    let newId: number;
    try {
      newId = await repo.insertRole(tx, {
        name: body.name,
        remark: body.remark ?? null,
        status: body.enabled ? 1 : 0,
        now,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('SYSTEM_ROLE_NAME_TAKEN');
      throw error;
    }
    await authAdminRepo.replaceRolePermissions(tx, newId, body.permissions);
    return newId;
  });
  return loadDetail(ctx, id);
}

export async function roleUpdate(
  ctx: Ctx,
  params: { id: string },
  form: RoleForm,
): Promise<RoleDetail> {
  const id = fromId(params.id);
  const body = { ...form, permissions: withRequirements(form.permissions) };
  assertPermissionsKnown(body.permissions);
  const existing = await repo.findRole(ctx.db, id);
  if (!existing) throw new DomainError('SYSTEM_ROLE_NOT_FOUND');
  // Both sides: adding an atom the caller lacks is a grant, and so is rewriting
  // (or stripping) a role more powerful than the caller.
  assertWithinOwnGrants(ctx, [...(await repo.permissionsOfRole(ctx.db, id)), ...body.permissions]);
  if (await repo.roleNameTaken(ctx.db, body.name, id)) {
    throw new DomainError('SYSTEM_ROLE_NAME_TAKEN');
  }

  const now = ctx.clock.now();
  await ctx.withTx(async (tx) => {
    try {
      await repo.updateRole(
        tx,
        id,
        { name: body.name, remark: body.remark ?? null, status: body.enabled ? 1 : 0 },
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('SYSTEM_ROLE_NAME_TAKEN');
      throw error;
    }
    await authAdminRepo.replaceRolePermissions(tx, id, body.permissions);
  });

  await revokeHolders(ctx, id, 'role permissions changed');
  return loadDetail(ctx, id);
}

export async function roleSetStatus(
  ctx: Ctx,
  params: { id: string },
  body: RoleStatusBody,
): Promise<RoleDetail> {
  const id = fromId(params.id);
  const existing = await repo.findRole(ctx.db, id);
  if (!existing) throw new DomainError('SYSTEM_ROLE_NOT_FOUND');
  assertWithinOwnGrants(ctx, await repo.permissionsOfRole(ctx.db, id));

  const to = body.enabled ? 1 : 0;
  const { won } = await repo.setRoleStatus(ctx.db, {
    id,
    from: to === 1 ? 0 : 1,
    to,
    now: ctx.clock.now(),
  });
  // Only the caller that flipped the row does the (expensive) revocation.
  if (won) await revokeHolders(ctx, id, 'role status changed');
  return loadDetail(ctx, id);
}

export async function roleDelete(ctx: Ctx, params: { id: string }): Promise<void> {
  const id = fromId(params.id);
  const existing = await repo.findRole(ctx.db, id);
  if (!existing) throw new DomainError('SYSTEM_ROLE_NOT_FOUND');
  assertWithinOwnGrants(ctx, await repo.permissionsOfRole(ctx.db, id));

  // The guard is inside the DELETE, so an admin granted this role a millisecond
  // ago still blocks it — a prior count would not.
  const { won } = await repo.deleteRoleIfUnused(ctx.db, id);
  if (!won) {
    // Two ways to lose: somebody holds the role, or somebody else deleted it
    // between the read above and the DELETE. Saying "in use by 0 admins" to the
    // second one would be a lie, so re-read before choosing the message.
    if (!(await repo.findRole(ctx.db, id))) throw new DomainError('SYSTEM_ROLE_NOT_FOUND');
    const counts = await repo.adminCounts(ctx.db, [id]);
    throw new DomainError('SYSTEM_ROLE_IN_USE', { details: { adminCount: counts.get(id) ?? 0 } });
  }
}

async function revokeHolders(ctx: Ctx, roleId: number, reason: string): Promise<void> {
  const adminIds = await repo.adminIdsWithRole(ctx.db, roleId);
  if (adminIds.length === 0) return;
  const store = createAdminSessionStore({ redis: ctx.redis });
  let revoked = 0;
  for (const adminId of adminIds) revoked += await store.revokeAllForAdmin(adminId);
  ctx.logger.info({ roleId, admins: adminIds.length, revoked }, reason);
}

/**
 * The permission tree.
 *
 * Grouped by the `section` each domain declared, falling back to the domain
 * name, and sorted so the ordering does not depend on module import order.
 */
export function permissionTree(): PermissionTree {
  const bySection = new Map<string, PermissionTree['sections'][number]['items']>();
  for (const atom of allPermissionAtoms()) {
    const section = atom.section ?? atom.domain;
    const items = bySection.get(section) ?? [];
    items.push({
      atom: atom.atom,
      label: atom.label,
      domain: atom.domain,
      requires: [...requirementsOf(atom.atom)],
    });
    bySection.set(section, items);
  }
  const sections = [...bySection.entries()]
    .map(([section, items]) => ({
      section,
      items: [...items].sort((a, b) => a.atom.localeCompare(b.atom)),
    }))
    .sort((a, b) => a.section.localeCompare(b.section, 'zh-Hans-CN'));

  return { sections, implicit: [...IMPLICIT_ADMIN_PERMISSIONS].sort() };
}

export async function permissionTreeRoute(_ctx: Ctx): Promise<PermissionTree> {
  return permissionTree();
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === '23505' || causeCode === '23505';
}
