import { describe, expect, it } from 'vitest';

import { hasPermission } from '../session/permissions';
import { filterMenu, findMenuTrail, flattenMenu, menuStateForPath } from './tree';
import { defineMenu, type MenuNode } from './types';

const registry: MenuNode[] = [
  defineMenu({ key: 'dashboard', label: '工作台', path: '/admin', order: 0 }),
  defineMenu({
    key: 'coupon',
    label: '营销',
    order: 300,
    children: [
      {
        key: 'coupon.templates',
        label: '优惠券',
        path: '/admin/coupons',
        permission: 'coupon:template:list',
        order: 10,
      },
      {
        key: 'coupon.edit',
        label: '编辑优惠券',
        path: '/admin/coupons/edit',
        permission: 'coupon:template:update',
        order: 20,
        hidden: true,
      },
    ],
  }),
  defineMenu({
    key: 'system',
    label: '系统',
    order: 200,
    children: [
      {
        key: 'system.admins',
        label: '管理员',
        path: '/admin/admins',
        permission: 'system:admin:list',
        order: 10,
      },
    ],
  }),
  defineMenu({ key: 'dev', label: '开发', order: 9000, devOnly: true, path: '/admin/dev' }),
] as MenuNode[];

function canFor(permissions: string[], isSuper = false) {
  const identity = { isSuper, permissions };
  return (required: Parameters<typeof hasPermission>[1]) => hasPermission(identity, required);
}

describe('filterMenu', () => {
  it('hides items the admin has no permission for', () => {
    const visible = filterMenu(registry, { can: canFor(['coupon:template:list']) });
    expect(visible.map((node) => node.key)).toEqual(['dashboard', 'coupon']);
    expect(visible.find((node) => node.key === 'coupon')?.children?.map((c) => c.key)).toEqual([
      'coupon.templates',
    ]);
  });

  it('drops a parent whose children all disappeared', () => {
    const visible = filterMenu(registry, { can: canFor([]) });
    expect(visible.map((node) => node.key)).toEqual(['dashboard']);
  });

  it('lets isSuper through everything', () => {
    const visible = filterMenu(registry, { can: canFor([], true) });
    expect(visible.map((node) => node.key)).toEqual(['dashboard', 'system', 'coupon']);
  });

  it('sorts by order then key', () => {
    const visible = filterMenu(registry, { can: canFor([], true) });
    expect(visible.map((node) => node.order)).toEqual([0, 200, 300]);
  });

  it('excludes devOnly unless asked, and hidden unless asked', () => {
    const production = filterMenu(registry, { can: canFor([], true) });
    expect(production.some((node) => node.key === 'dev')).toBe(false);

    const development = filterMenu(registry, { can: canFor([], true), includeDev: true });
    expect(development.some((node) => node.key === 'dev')).toBe(true);

    const withHidden = filterMenu(registry, { can: canFor([], true), includeHidden: true });
    const coupon = withHidden.find((node) => node.key === 'coupon');
    expect(coupon?.children?.map((c) => c.key)).toEqual(['coupon.templates', 'coupon.edit']);
  });

  it('leaves the source registry untouched', () => {
    filterMenu(registry, { can: canFor([]) });
    expect(flattenMenu(registry)).toHaveLength(7);
  });
});

describe('findMenuTrail', () => {
  const all = filterMenu(registry, {
    can: canFor([], true),
    includeHidden: true,
    includeDev: true,
  });

  it('returns the ancestor chain, root first', () => {
    expect(findMenuTrail(all, '/admin/coupons').map((node) => node.key)).toEqual([
      'coupon',
      'coupon.templates',
    ]);
  });

  it('matches a detail URL to its list node by path prefix', () => {
    expect(findMenuTrail(all, '/admin/coupons/12').map((node) => node.key)).toEqual([
      'coupon',
      'coupon.templates',
    ]);
  });

  it('prefers the longest matching path', () => {
    expect(findMenuTrail(all, '/admin/coupons/edit').map((node) => node.key)).toEqual([
      'coupon',
      'coupon.edit',
    ]);
  });

  it('does not match a sibling that merely shares a prefix string', () => {
    expect(findMenuTrail(all, '/admin/couponsomething')).toEqual([]);
  });

  it('returns nothing for an unknown URL', () => {
    expect(findMenuTrail(all, '/admin/nowhere')).toEqual([]);
  });
});

describe('menuStateForPath', () => {
  it('selects the leaf and opens its ancestors', () => {
    const visible = filterMenu(registry, { can: canFor([], true) });
    expect(menuStateForPath(visible, '/admin/coupons')).toEqual({
      selectedKeys: ['coupon.templates'],
      openKeys: ['coupon'],
    });
  });
});

describe('defineMenu', () => {
  it('rejects a duplicate key', () => {
    expect(() =>
      defineMenu({
        key: 'a',
        label: 'A',
        order: 1,
        children: [{ key: 'a', label: 'A again', order: 1 }],
      }),
    ).toThrow('菜单 key 重复：a');
  });

  it('rejects a path outside /admin', () => {
    expect(() => defineMenu({ key: 'b', label: 'B', order: 1, path: '/shop' })).toThrow(
      '必须以 /admin 开头',
    );
  });
});

describe('hasPermission', () => {
  it('passes everything for a super admin', () => {
    expect(hasPermission({ isSuper: true, permissions: [] }, 'anything:at:all')).toBe(true);
  });

  it('treats an array as "any of"', () => {
    const identity = { isSuper: false, permissions: ['b'] };
    expect(hasPermission(identity, ['a', 'b'])).toBe(true);
    expect(hasPermission(identity, ['a', 'c'])).toBe(false);
  });

  it('passes an unset requirement, fails without an identity', () => {
    expect(hasPermission({ isSuper: false, permissions: [] }, undefined)).toBe(true);
    expect(hasPermission(null, undefined)).toBe(false);
  });
});
