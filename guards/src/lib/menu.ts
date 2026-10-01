import { menuRegistry } from '../../../apps/web/src/admin/menu/menu.gen';

/**
 * The admin sider, flattened.
 *
 * `menu.gen.ts` is `pnpm gen`'s output and the menu files are deliberately
 * plain data (no JSX, no React import), which is what lets a guard read the
 * real registry rather than a regex over the source.
 */

export interface MenuEntry {
  key: string;
  path: string | undefined;
  atoms: string[];
  devOnly: boolean;
}

interface RawNode {
  key: string;
  path?: string | undefined;
  permission?: string | readonly string[] | undefined;
  devOnly?: boolean | undefined;
  children?: readonly RawNode[] | undefined;
}

export function menuPermissions(): MenuEntry[] {
  const out: MenuEntry[] = [];
  const walk = (nodes: readonly RawNode[], devOnly: boolean): void => {
    for (const node of nodes) {
      const dev = devOnly || node.devOnly === true;
      const permission = node.permission;
      const atoms = permission === undefined ? [] : [permission].flat();
      if (atoms.length > 0 || node.path) {
        out.push({ key: node.key, path: node.path, atoms, devOnly: dev });
      }
      if (node.children) walk(node.children, dev);
    }
  };
  walk(menuRegistry as readonly RawNode[], false);
  return out;
}
