import type { PermissionInput } from '../session/permissions';
import type { MenuNode } from './types';

export interface MenuFilterOptions {
  /** Permission test, normally `useCan()`. */
  can: (required: PermissionInput) => boolean;
  /** Include `devOnly` nodes. The shell passes `NODE_ENV !== 'production'`. */
  includeDev?: boolean | undefined;
  /** Include `hidden` nodes. Breadcrumb resolution wants them; the sider does not. */
  includeHidden?: boolean | undefined;
}

function byOrder(a: MenuNode, b: MenuNode): number {
  return a.order - b.order || a.key.localeCompare(b.key);
}

/**
 * Drops what the current admin may not see, then drops any parent left without
 * visible children and without a path of its own.
 */
export function filterMenu(nodes: readonly MenuNode[], options: MenuFilterOptions): MenuNode[] {
  const { can, includeDev = false, includeHidden = false } = options;

  const visit = (list: readonly MenuNode[]): MenuNode[] => {
    const out: MenuNode[] = [];
    for (const node of list) {
      if (node.devOnly && !includeDev) continue;
      if (node.hidden && !includeHidden) continue;
      if (!can(node.permission)) continue;
      const children = node.children ? visit(node.children) : undefined;
      const hasChildren = children !== undefined && children.length > 0;
      // A grouping node with nothing left under it disappears.
      if (node.children && !hasChildren && !node.path) continue;
      out.push(hasChildren ? { ...node, children } : stripChildren(node));
    }
    return out.sort(byOrder);
  };

  return visit(nodes);
}

function stripChildren(node: MenuNode): MenuNode {
  if (!node.children) return node;
  const { children: _children, ...rest } = node;
  return rest;
}

/** Depth-first flattening, parents first. */
export function flattenMenu(nodes: readonly MenuNode[]): MenuNode[] {
  const out: MenuNode[] = [];
  const visit = (list: readonly MenuNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

/**
 * Ancestor chain for a URL, longest path-prefix wins, so
 * `/admin/coupons/3/edit` resolves to the `/admin/coupons` node's chain unless
 * a hidden node declares the detail path itself.
 */
export function findMenuTrail(nodes: readonly MenuNode[], pathname: string): MenuNode[] {
  let best: MenuNode[] = [];
  const visit = (list: readonly MenuNode[], trail: readonly MenuNode[]): void => {
    for (const node of list) {
      const next = [...trail, node];
      if (node.path && matchesPath(node.path, pathname)) {
        const bestPath = best.at(-1)?.path ?? '';
        if (node.path.length > bestPath.length) best = next;
      }
      if (node.children) visit(node.children, next);
    }
  };
  visit(nodes, []);
  return best;
}

const ADMIN_ROOT = '/admin';

function matchesPath(menuPath: string, pathname: string): boolean {
  if (pathname === menuPath) return true;
  // The dashboard's `/admin` is a prefix of every admin URL; matching it by
  // prefix would make every page claim the dashboard as an ancestor.
  if (menuPath === ADMIN_ROOT) return false;
  return pathname.startsWith(menuPath.endsWith('/') ? menuPath : `${menuPath}/`);
}

/** `{ selectedKeys, openKeys }` for antd's `<Menu/>`, derived from the URL. */
export function menuStateForPath(
  nodes: readonly MenuNode[],
  pathname: string,
): { selectedKeys: string[]; openKeys: string[] } {
  const trail = findMenuTrail(nodes, pathname);
  if (trail.length === 0) return { selectedKeys: [], openKeys: [] };
  const leaf = trail[trail.length - 1];
  return {
    selectedKeys: leaf ? [leaf.key] : [],
    openKeys: trail.slice(0, -1).map((node) => node.key),
  };
}
