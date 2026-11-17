import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  systemAdminList,
  systemAdminSetStatus,
  systemAdminUpdate,
} from '@shop/contracts/system/system.admin.contract';
import { systemRoleList } from '@shop/contracts/system/system.role.contract';
import {
  adminListItemExample,
  roleListItemExample,
  type AdminListItem,
} from '@shop/contracts/system/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { AdminsPage } from './admins';

const operator: AdminListItem = {
  ...adminListItemExample,
  id: '2',
  account: 'operator',
  name: '运营',
  isSuper: false,
};

function stubApi(): StubCall[] {
  return stubRoutes([
    on(systemAdminList, { items: [operator], total: 1, page: 1, pageSize: 20 }),
    on(systemRoleList, { items: [roleListItemExample], total: 1, page: 1, pageSize: 100 }),
    on(systemAdminSetStatus, { admin: { ...operator, enabled: false }, revokedSessions: 2 }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const manager = {
  ...testIdentity,
  permissions: ['system:admin:read', 'system:admin:write', 'system:role:read'],
};

describe('管理员', () => {
  it('asks before 停用, naming the account, then sends the status change', async () => {
    const calls = stubApi();
    renderAdmin(<AdminsPage />, { identity: manager });
    await screen.findByText('operator');

    await userEvent.click(screen.getByRole('button', { name: zhName('停用') }));
    const ask = await screen.findByText('停用管理员「operator」？');
    expect(calls.some((call) => call.url.includes('/status'))).toBe(false);
    const popup = ask.closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: zhName('停用') }));

    await waitFor(() => {
      const toggle = calls.find((call) => call.url.includes('/admin-api/admins/2/status'));
      expect(toggle?.body).toEqual({ enabled: false });
    });
  });

  it('does not ask for the role list without system:role:read (no 403 toast)', async () => {
    const calls = stubApi();
    renderAdmin(<AdminsPage />, {
      identity: { ...testIdentity, permissions: ['system:admin:read', 'system:admin:write'] },
    });
    await screen.findByText('operator');

    expect(calls.some((call) => call.url.includes('/admin-api/roles'))).toBe(false);
  });

  it('edits an admin with an existing avatar without sending avatar: null', async () => {
    const withAvatar: AdminListItem = { ...operator, avatar: 'https://cdn.example.com/a.png' };
    const calls = stubRoutes([
      on(systemAdminList, { items: [withAvatar], total: 1, page: 1, pageSize: 20 }),
      on(systemRoleList, { items: [roleListItemExample], total: 1, page: 1, pageSize: 100 }),
      on(systemAdminUpdate, { admin: { ...withAvatar, name: '新运营' }, revokedSessions: 1 }),
    ]);
    renderAdmin(<AdminsPage />, { identity: manager });
    await screen.findByText('operator');

    await userEvent.click(screen.getByRole('button', { name: zhName('编辑') }));
    const dialog = await screen.findByRole('dialog');
    const nameInput = within(dialog).getByLabelText('姓名');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, '新运营');
    await userEvent.click(within(dialog).getByRole('button', { name: zhName('保存') }));

    await waitFor(() => {
      const update = calls.find((call) => call.routeId === systemAdminUpdate.id);
      expect(update?.body).toMatchObject({ name: '新运营' });
      expect(update?.body).not.toHaveProperty('avatar');
    });
  });
});
