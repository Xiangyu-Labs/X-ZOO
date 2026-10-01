import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  systemPermissionTree,
  systemRoleDetail,
  systemRoleList,
} from '@shop/contracts/system/system.role.contract';
import { roleDetailExample, roleListItemExample } from '@shop/contracts/system/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { RolesPage } from './roles';

/**
 * 身份管理 as a component test.
 *
 * The edit dialog is the part worth asserting: the row carries no grants, so
 * the form must open on the detail — a form seeded before the detail lands
 * would save the role with its name blank and every permission revoked.
 */

function stubApi(): StubCall[] {
  return stubRoutes([
    on(systemRoleList, { items: [roleListItemExample], total: 1, page: 1, pageSize: 20 }),
    on(systemRoleDetail, { ...roleDetailExample, remark: '详情里的备注' }),
    on(systemPermissionTree, { sections: [], implicit: [] }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const writer = {
  ...testIdentity,
  permissions: ['system:role:read', 'system:role:write'],
};

describe('身份管理', () => {
  it('opens 编辑 on the loaded role, not an empty form', async () => {
    const calls = stubApi();
    renderAdmin(<RolesPage />, { identity: writer });
    await screen.findByText('商品与营销');

    await userEvent.click(screen.getByRole('button', { name: '编辑' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByDisplayValue('详情里的备注')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('运营')).toBeInTheDocument();
    expect(calls.some((call) => call.url.endsWith('/admin-api/roles/2'))).toBe(true);
  });
});
