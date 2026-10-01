import type { PermissionInput } from '../session/permissions';

/**
 * One entry in the admin sider.
 *
 * Menu files are plain data (no JSX, no React imports) so that the `gen` script
 * can aggregate them and so a node can be read on the server. Icons are named
 * after an `@ant-design/icons` export and resolved by `menu/icons.tsx`.
 */
export interface MenuNode {
  /** Globally unique, dot-separated, mirrors the domain: `coupon.templates`. */
  key: string;
  label: string;
  /** `@ant-design/icons` export name, e.g. `'ShopOutlined'`. Top level should always set one. */
  icon?: string | undefined;
  /** Absolute admin path. Omit for a pure grouping node. */
  path?: string | undefined;
  /** Hidden unless the admin holds it (array = any of). Leave unset for "everyone". */
  permission?: PermissionInput | undefined;
  /** Ascending. Convention: 100-step gaps between domains, 10-step inside one. */
  order: number;
  /**
   * Reachable and breadcrumb-able but never listed in the sider — detail pages,
   * `…/new`, `…/:id/edit`.
   */
  hidden?: boolean | undefined;
  /** Dropped from production builds. Used by the kit demo. */
  devOnly?: boolean | undefined;
  children?: MenuNode[] | undefined;
}

/**
 * Declares menu entries for a domain. Put them in
 * `src/admin/menu/<domain>.menu.ts` and default-export the result; `pnpm gen`
 * aggregates every such file into `menu.gen.ts`, so no shared index is edited
 * and two domains never conflict.
 *
 * ```ts
 * export default defineMenu({
 *   key: 'coupon',
 *   label: '优惠券',
 *   icon: 'TagsOutlined',
 *   order: 300,
 *   children: [
 *     { key: 'coupon.templates', label: '优惠券列表', path: '/admin/coupons',
 *       permission: 'coupon:template:list', order: 10 },
 *   ],
 * });
 * ```
 */
export function defineMenu<const T extends MenuNode | readonly MenuNode[]>(node: T): T {
  const nodes = Array.isArray(node) ? (node as readonly MenuNode[]) : [node as MenuNode];
  const seen = new Set<string>();
  const walk = (list: readonly MenuNode[]): void => {
    for (const item of list) {
      if (seen.has(item.key)) throw new Error(`菜单 key 重复：${item.key}`);
      seen.add(item.key);
      if (item.path && !item.path.startsWith('/admin')) {
        throw new Error(`菜单 ${item.key} 的 path 必须以 /admin 开头`);
      }
      if (item.children) walk(item.children);
    }
  };
  walk(nodes);
  return node;
}
