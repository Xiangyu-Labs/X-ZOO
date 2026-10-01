import { allRoutes, routeSources } from '@shop/contracts/routes';
import { allPermissionAtoms, isKnownPermission } from '@shop/core/auth';
import { allConfigGroups } from '@shop/core/kernel';
import { defineCheck, fail, result, type Finding } from '../framework';
import { menuPermissions } from '../lib/menu';
import '../lib/install-domains';

/**
 * Three facts about the permission set, checked against each other:
 *
 *   1. every `auth: 'admin'` route names an atom that `permissions.ts` declares
 *      (`defineRoute` already refuses a route with no atom at all, so what is
 *      left to catch is a *typo* — an atom nobody declares can never be granted,
 *      which locks the screen for everybody including the super admin);
 *   2. every menu entry's atom is declared, or the entry is invisible for ever;
 *   3. no atom is unused — an atom no route and no menu entry names is a
 *      checkbox in the role editor that grants nothing, and usually means a
 *      route borrowed a neighbour's atom instead — the way 商品保障 must not
 *      hide inside the 商品参数 group (CAT-016).
 *
 * The implicit atoms every admin holds (`auth:profile:*`) are exempt from (3):
 * they are granted by `IMPLICIT_ADMIN_PERMISSIONS`, not by a role.
 */

const IMPLICITLY_HELD = /^auth:profile:/;

export const permissions = defineCheck(
  'permissions',
  'route, menu and declared permission atoms agree',
  () => {
    const findings: Finding[] = [];
    const declared = allPermissionAtoms();
    const used = new Map<string, string[]>();

    const use = (atom: string, where: string): void => {
      used.set(atom, [...(used.get(atom) ?? []), where]);
    };

    for (const route of allRoutes) {
      if (route.auth !== 'admin') {
        if (route.permission) {
          findings.push(fail(route.id, `declares a permission but its auth is '${route.auth}'`));
        }
        continue;
      }
      const atom = route.permission;
      if (!atom) {
        findings.push(fail(route.id, 'is an admin route with no permission'));
        continue;
      }
      if (!isKnownPermission(atom)) {
        findings.push(
          fail(
            routeSources[route.id] ?? route.id,
            `${route.id} requires "${atom}", which no permissions.ts declares — the route can never be granted`,
          ),
        );
        continue;
      }
      use(atom, route.id);
    }

    for (const entry of menuPermissions()) {
      for (const atom of entry.atoms) {
        if (!isKnownPermission(atom)) {
          findings.push(
            fail(
              `menu ${entry.key}`,
              `requires "${atom}", which no permissions.ts declares — the entry is invisible to everyone`,
            ),
          );
          continue;
        }
        use(atom, `menu ${entry.key}`);
      }
    }

    // A config group names its read atom and `configSave` derives the write one
    // (`system:config:read` -> `system:config:write`), so both count as used:
    // neither is named by any route, because one generic route serves every
    // group.
    for (const group of allConfigGroups()) {
      const read = group.permission ?? 'system:config:read';
      const write = read.endsWith(':read') ? `${read.slice(0, -5)}:write` : read;
      for (const atom of [read, write]) {
        if (!isKnownPermission(atom)) {
          findings.push(
            fail(
              `config group ${group.group}`,
              `requires "${atom}", which no permissions.ts declares — the settings screen is unreachable`,
            ),
          );
          continue;
        }
        use(atom, `config group ${group.group}`);
      }
    }

    for (const atom of declared) {
      if (used.has(atom.atom)) continue;
      if (IMPLICITLY_HELD.test(atom.atom)) continue;
      findings.push(
        fail(
          atom.atom,
          `is declared (${atom.label}) but no route and no menu entry names it — it grants nothing`,
        ),
      );
    }

    return result(
      'permissions',
      'permission atoms',
      `${declared.length} declared atoms; ${used.size} of them used by ${allRoutes.filter((r) => r.auth === 'admin').length} admin routes and ${menuPermissions().length} menu entries`,
      findings,
    );
  },
);
