/**
 * Permission atoms.
 *
 * Atoms are declared in `core/<domain>/permissions.ts`; the database stores
 * only `roles / role_permissions / admin_roles`. The set of atoms is compiled
 * into the app; only the *grants* are data. A renamed atom is therefore a code
 * change plus a data fix-up, never a migration, and a role that still grants a
 * retired atom simply grants nothing.
 */

export interface PermissionAtom {
  /** `<domain>:<resource>:<action>` */
  atom: string;
  domain: string;
  label: string;
  /** Group heading in the role editor. Defaults to the resource name. */
  section?: string;
}

const registry = new Map<string, PermissionAtom>();

/**
 * Declares a domain's atoms and returns them as a typed lookup.
 *
 * @example
 * export const couponPermissions = definePermissions('coupon', {
 *   'coupon:read': '查看优惠券',
 *   'coupon:create': '新建优惠券',
 * });
 * // couponPermissions['coupon:read'] === 'coupon:coupon:read'
 */
export function definePermissions<const T extends Record<string, string>>(
  domain: string,
  specs: T,
  options: { section?: string } = {},
): Readonly<Record<keyof T, string>> {
  if (!/^[a-z][a-z0-9-]*$/.test(domain)) {
    throw new Error(`permission domain "${domain}" 必须是小写短横线命名`);
  }
  const out: Record<string, string> = {};
  for (const [key, label] of Object.entries(specs)) {
    if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(key)) {
      throw new Error(`permission "${key}" 必须是 <resource>:<action> 形式`);
    }
    const atom = `${domain}:${key}`;
    const existing = registry.get(atom);
    if (existing && existing.label !== label) {
      throw new Error(`permission atom "${atom}" 重复定义`);
    }
    const entry: PermissionAtom = {
      atom,
      domain,
      label,
      ...(options.section ? { section: options.section } : {}),
    };
    registry.set(atom, entry);
    out[key] = atom;
  }
  return Object.freeze(out) as Readonly<Record<keyof T, string>>;
}

export function allPermissionAtoms(): PermissionAtom[] {
  return [...registry.values()].sort((a, b) => a.atom.localeCompare(b.atom));
}

export function isKnownPermission(atom: string): boolean {
  return registry.has(atom);
}

/** Test helper. Never call this from app code. */
export function resetPermissionRegistry(): void {
  registry.clear();
}

/**
 * The caller's own account, declared here because `contracts/src/auth` and
 * `contracts/src/system` need the atoms and `defineRoute` (frozen) requires
 * every `auth: 'admin'` route to name one. Every authenticated admin holds
 * these implicitly — see `IMPLICIT_ADMIN_PERMISSIONS` in `rbac.ts` — because an
 * account created with an empty role has to be able to see who it is and change
 * its own password, or the first login is a dead end.
 */
export const authPermissions = definePermissions(
  'auth',
  {
    'session:read': '读取自己的登录信息',
    'session:delete': '退出登录',
    'profile:read': '查看自己的资料',
    'profile:update': '修改自己的资料与密码',
    'api-token:self': '管理自己的 API 令牌（AI 助手、命令行）',
  },
  { section: '账号' },
);
