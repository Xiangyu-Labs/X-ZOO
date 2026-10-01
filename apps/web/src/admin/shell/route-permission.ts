import type { PermissionInput } from '../session/permissions';
import type { MenuNode } from '../menu/types';

/**
 * Which atoms a URL needs, read off the menu registry.
 *
 * `RequirePermission` existed and no page used it, so a role-restricted admin
 * who followed a link to a page outside their role got the page's chrome and a
 * toast per failed fetch instead of a 403. The menu already pairs every screen
 * with the atom its list route requires — it is the generated fact the CR
 * points at — so the shell applies the guard for every page at once, and a new
 * page is guarded the moment it gets its menu entry.
 *
 * The URL resolves to the deepest menu node whose path matches it (a path
 * segment written `:id` or `[id]` matches any one segment, and loses a tie to
 * a literal one; a shorter path matches as a prefix, except the dashboard's
 * bare `/admin`), and needs every
 * `permission` along that node's trail. No match → no requirement: the page
 * decides for itself, and the server still checks every call.
 */
export function requiredPermissions(
  nodes: readonly MenuNode[],
  pathname: string,
): PermissionInput[] {
  const target = segments(pathname);
  const best = { depth: -1, trail: [] as readonly MenuNode[] };

  const visit = (list: readonly MenuNode[], trail: readonly MenuNode[]): void => {
    for (const node of list) {
      const next = [...trail, node];
      if (node.path) {
        const depth = matchDepth(segments(node.path), target);
        if (depth !== null && depth > best.depth) {
          best.depth = depth;
          best.trail = next;
        }
      }
      if (node.children) visit(node.children, next);
    }
  };
  visit(nodes, []);

  return best.trail
    .map((node) => node.permission)
    .filter((p) => p !== undefined && (typeof p === 'string' || p.length > 0));
}

/** Whether a URL resolves to any menu node at all. For the coverage test. */
export function isCoveredByMenu(nodes: readonly MenuNode[], pathname: string): boolean {
  const target = segments(pathname);
  const visit = (list: readonly MenuNode[]): boolean =>
    list.some(
      (node) =>
        (node.path !== undefined && matchDepth(segments(node.path), target) !== null) ||
        (node.children !== undefined && visit(node.children)),
    );
  return visit(nodes);
}

function segments(path: string): string[] {
  return path.split('?')[0]!.split('/').filter(Boolean);
}

const PARAM = /^(:.+|\[.+\])$/;

/**
 * How well a menu path matches, or `null`: more segments win, and at equal
 * length a literal segment beats a parameter (`/admin/orders/invoices` over
 * `/admin/orders/:id`). The bare `/admin` matches only itself.
 */
function matchDepth(menu: readonly string[], target: readonly string[]): number | null {
  if (menu.length > target.length) return null;
  if (menu.length === 1 && target.length > 1) return null;
  let literals = 0;
  for (let index = 0; index < menu.length; index += 1) {
    const expected = menu[index]!;
    if (PARAM.test(expected)) continue;
    if (expected !== target[index]) return null;
    literals += 1;
  }
  return menu.length * 100 + literals;
}
