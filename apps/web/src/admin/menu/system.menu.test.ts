import { describe, expect, it } from 'vitest';

import { hasPermission } from '../session/permissions';
import storageMenu from './storage.menu';
import systemMenu from './system.menu';
import { filterMenu, flattenMenu } from './tree';
import type { MenuNode } from './types';

/**
 * The sider half of the permission boundary. The server half — every one of
 * these routes answering 403 without the atom — is proved in
 * `app/admin-api/admins/system.int.test.ts` and
 * `app/admin-api/attachments/storage.int.test.ts`. Both halves have to hold:
 * a 403 behind a visible menu entry is a bug report waiting to happen, and a
 * hidden entry in front of an open route is a hole.
 */
const registry: MenuNode[] = [systemMenu, storageMenu];

function canFor(permissions: string[], isSuper = false) {
  const identity = { isSuper, permissions };
  return (required: Parameters<typeof hasPermission>[1]) => hasPermission(identity, required);
}

function visibleKeys(permissions: string[], isSuper = false): string[] {
  return flattenMenu(filterMenu(registry, { can: canFor(permissions, isSuper) })).map(
    (node) => node.key,
  );
}

describe('system sider entries', () => {
  it('shows an admin with no grants at all nothing', () => {
    // 个人资料 needs no atom but is `hidden`, so it is reachable from the avatar
    // menu and from the breadcrumb without occupying a sider row.
    expect(visibleKeys([])).toEqual([]);
  });

  it('shows one atom-holder exactly one entry, and drops the empty parent', () => {
    expect(visibleKeys(['system:audit:read'])).toEqual(['system', 'system.auditLogs']);
    expect(visibleKeys(['storage:attachment:read'])).toEqual(['storage', 'storage.attachments']);
  });

  it('never shows an entry whose atom the role does not hold', () => {
    const everyAtom = flattenMenu(registry)
      .map((node) => node.permission)
      .filter((permission): permission is string => typeof permission === 'string');
    expect(everyAtom.length).toBeGreaterThan(0);
    for (const atom of new Set(everyAtom)) {
      const others = flattenMenu(filterMenu(registry, { can: canFor([atom]), includeHidden: true }))
        .filter((node) => typeof node.permission === 'string' && node.permission !== atom)
        .map((node) => node.key);
      expect(others, `holding only ${atom}`).toEqual([]);
    }
  });

  it('shows a super admin every entry, hidden ones excepted', () => {
    expect(visibleKeys([], true)).toEqual([
      'storage',
      'storage.attachments',
      'system',
      'system.settings',
      'system.admins',
      'system.roles',
      'system.auditLogs',
      'system.failedJobs',
    ]);
  });

  it('keeps the settings-group route hidden but resolvable', () => {
    const withHidden = flattenMenu(
      filterMenu(registry, { can: canFor([], true), includeHidden: true }),
    ).map((node) => node.key);
    expect(withHidden).toContain('system.settings.group');
    expect(withHidden).toContain('system.profile');
  });
});
