import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { authPermissions } from './permissions';

/**
 * The permission check. Two rules and nothing else:
 *
 *  1. a super admin passes everything;
 *  2. otherwise the atom must be in the actor's granted set.
 *
 * There is no wildcard, no hierarchy and no "implies". A screen that needs two
 * things checks two atoms. Cleverness here is how a system ends up with
 * permissions nobody can reason about.
 */

/**
 * Atoms every authenticated admin holds without a grant. They reach only the
 * admin's *own* session and *own* account, which is a precondition for the
 * admin UI to function at all: an account created with an empty role must
 * still be able to see who it is and change its own password. `defineRoute`
 * (frozen) also demands a permission on every `auth: 'admin'` route, so
 * `/admin-api/auth/me` and `/admin-api/profile` have to name something.
 *
 * The role editor renders these checked and disabled rather than as choices —
 * they must not be clearable.
 */
export const IMPLICIT_ADMIN_PERMISSIONS: readonly string[] = Object.freeze([
  authPermissions['session:read'],
  authPermissions['session:delete'],
  authPermissions['profile:read'],
  authPermissions['profile:update'],
  // A token acts with its owner's own roles, so minting one grants nothing new.
  authPermissions['api-token:self'],
]);

export function hasPermission(actor: Actor, atom: string): boolean {
  if (actor.kind === 'system') return true;
  if (actor.kind !== 'admin') return false;
  if (actor.isSuper) return true;
  if (IMPLICIT_ADMIN_PERMISSIONS.includes(atom)) return true;
  return actor.permissions.includes(atom);
}

export function hasEveryPermission(actor: Actor, atoms: readonly string[]): boolean {
  return atoms.every((atom) => hasPermission(actor, atom));
}

export function hasSomePermission(actor: Actor, atoms: readonly string[]): boolean {
  return atoms.some((atom) => hasPermission(actor, atom));
}

/** 401 when nobody is logged in, 403 when somebody is but may not do this. */
export function requirePermission(ctx: Ctx, atom: string): void {
  if (ctx.actor.kind === 'anonymous') throw new DomainError('UNAUTHENTICATED');
  if (!hasPermission(ctx.actor, atom)) {
    throw new DomainError('FORBIDDEN', { details: { permission: atom } });
  }
}

/**
 * The effective list the admin shell receives in `/admin-api/auth/me`. A super
 * admin gets every granted atom *plus* `isSuper: true`; `<Can>` must
 * short-circuit on the flag rather than trying to enumerate everything.
 */
export function effectivePermissions(granted: readonly string[]): string[] {
  return [...new Set([...IMPLICIT_ADMIN_PERMISSIONS, ...granted])].sort();
}
