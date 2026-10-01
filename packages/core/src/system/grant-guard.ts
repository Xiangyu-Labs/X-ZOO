import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { hasPermission, IMPLICIT_ADMIN_PERMISSIONS } from '../auth/rbac';
import * as repo from './system.repo';

/**
 * "You cannot hand out what you do not hold."
 *
 * Without this, `system:admin:write` and `system:role:write` are each a way to
 * become a super admin: reset a super admin's password, give yourself a bigger
 * role, or tick every box on your own role. So, for a non-super caller:
 *
 * - every atom a role is given, or a role already grants, must be one the
 *   caller holds — creating, editing, switching on or off and deleting alike;
 * - an admin may only be given roles within the caller's grants;
 * - an admin may only be managed at all (edited, reset, switched off, deleted)
 *   when they are not a super admin and every role they hold is within the
 *   caller's grants.
 *
 * Super admins, and the system actor, are unaffected.
 */

function exempt(ctx: Ctx): boolean {
  return ctx.actor.kind === 'system' || (ctx.actor.kind === 'admin' && ctx.actor.isSuper);
}

/** Refuses when `atoms` include any the caller does not hold. */
export function assertWithinOwnGrants(ctx: Ctx, atoms: readonly string[]): void {
  if (exempt(ctx)) return;
  const beyond = atoms.filter(
    (atom) => !IMPLICIT_ADMIN_PERMISSIONS.includes(atom) && !hasPermission(ctx.actor, atom),
  );
  if (beyond.length > 0) {
    throw new DomainError('SYSTEM_GRANT_EXCEEDS_OWN', {
      details: { permissions: [...new Set(beyond)].sort() },
    });
  }
}

/** Refuses when the roles grant anything the caller does not hold. */
export async function assertRolesWithinOwnGrants(
  ctx: Ctx,
  roleIds: readonly number[],
): Promise<void> {
  if (exempt(ctx)) return;
  assertWithinOwnGrants(ctx, await repo.permissionsOfRoles(ctx.db, roleIds));
}

/** Refuses to let the caller manage a super admin, or anybody holding more than they do. */
export async function assertMayManageAdmin(
  ctx: Ctx,
  target: { id: number; isSuper: boolean },
): Promise<void> {
  if (exempt(ctx)) return;
  if (target.isSuper) throw new DomainError('SYSTEM_GRANT_EXCEEDS_OWN');
  await assertRolesWithinOwnGrants(ctx, await repo.roleIdsOfAdmin(ctx.db, target.id));
}
