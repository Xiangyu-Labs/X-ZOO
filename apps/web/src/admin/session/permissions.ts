import type { AdminIdentity } from '../api/contracts';

/** One atom, or "any of these atoms". */
export type PermissionInput = string | readonly string[] | undefined;

/**
 * Client-side permission test. Mirrors the server check but is only ever a UX
 * affordance — the server re-checks every admin route's declared permission.
 *
 * `isSuper` passes everything. An empty/absent requirement passes for any
 * signed-in admin.
 */
export function hasPermission(
  identity: Pick<AdminIdentity, 'isSuper' | 'permissions'> | null | undefined,
  required: PermissionInput,
): boolean {
  if (!identity) return false;
  if (identity.isSuper) return true;
  if (required === undefined) return true;
  const list = typeof required === 'string' ? [required] : required;
  if (list.length === 0) return true;
  const owned = new Set(identity.permissions);
  return list.some((atom) => owned.has(atom));
}
