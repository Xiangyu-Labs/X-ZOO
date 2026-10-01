import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  userAdminBatchSetGroups,
  userAdminBatchSetLabels,
  userAdminCreate,
  userAdminDetail,
  userAdminList,
  userAdminResetPassword,
  userAdminSetStatus,
  userAdminUpdate,
} from '@shop/contracts/user/user.admin.contract';
import { userGroupList, userLabelList } from '@shop/contracts/user/user.taxonomy.contract';
import {
  couponAdminGrant,
  couponAdminGrantBatch,
  couponAdminList,
} from '@shop/contracts/coupon/coupon.admin.contract';
import { couponTemplateExample } from '@shop/contracts/coupon/schemas';
import type { AdminUserDetail, AdminUserListItem } from '@shop/contracts/user/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { CustomersPage } from './customers';

// The list's filters live in the URL; a test that filters sets them here.
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/user/customers',
  useSearchParams: () => search,
}));

/**
 * 用户列表 as a component test: no browser, no server, one stub `fetch`.
 *
 * What is worth asserting on a kit-built page is the wiring — that the table
 * asks the contract's route, that the masked number is what an operator sees,
 * that each destructive action sits behind its own permission atom, and that a
 * click sends the body the contract declares. Paging, sorting and form
 * rendering are the kit's own tests' job.
 */

const row: AdminUserListItem = {
  id: '1001',
  account: '13800138000',
  phone: '138****8000',
  nickname: '小明',
  avatarUrl: null,
  status: 'active',
  registerSource: 'h5',
  groups: [{ id: '3', name: '高价值客户' }],
  labels: [{ id: '7', name: '母婴' }],
  lastLoginAt: '2026-09-20T08:31:00+08:00',
  createdAt: '2026-01-05T10:00:00+08:00',
};

/** The detail route's shape; the drawer reads every one of these. */
const detail: AdminUserDetail = {
  ...row,
  phone: '13800138000',
  // Three fields the list row does not carry. They are here rather than `null`
  // so the edit test can watch them survive a save.
  realName: '王小明',
  birthday: null,
  adminRemark: '老客户，走加急',
  registerIp: '10.0.0.1',
  lastLoginIp: '10.0.0.2',
  hasPassword: true,
  boundWechat: ['mini'],
  addressCount: 1,
  deletedAt: null,
  updatedAt: '2026-09-20T08:31:00+08:00',
};

function stubApi(
  current: AdminUserDetail = detail,
  total = 1,
  listed: AdminUserListItem = row,
): StubCall[] {
  return stubRoutes([
    on(userGroupList, {
      items: [
        { id: '3', name: '高价值客户', sortOrder: 0, memberCount: 1, createdAt: row.createdAt },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    }),
    on(userLabelList, {
      items: [
        {
          id: '7',
          categoryId: null,
          categoryName: null,
          name: '母婴',
          sortOrder: 0,
          memberCount: 1,
          createdAt: row.createdAt,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    }),
    on(userAdminList, { items: [listed], total, page: 1, pageSize: 20 }),
    on(userAdminDetail, current),
    on(userAdminUpdate, detail),
    on(userAdminCreate, { ...detail, registerSource: 'admin' }),
    on(userAdminSetStatus, { ...detail, status: 'disabled' }),
    on(userAdminResetPassword, { ok: true, revokedSessions: 2 }),
    on(userAdminBatchSetGroups, { affected: 1 }),
    on(userAdminBatchSetLabels, { affected: 1 }),
    on(couponAdminList, { items: [couponTemplateExample], total: 1, page: 1, pageSize: 50 }),
    on(couponAdminGrant, { granted: 1, skippedUserIds: [] }),
    on(couponAdminGrantBatch, { matched: 1, granted: 0, skippedUserIds: ['1001'] }),
  ]);
}

afterEach(() => {
  resetApiConfig();
  search = new URLSearchParams();
});

const allPermissions = {
  ...testIdentity,
  permissions: [
    'user:customer:read',
    'user:customer:write',
    'user:customer:status',
    'user:customer:password',
    'user:group:read',
    'user:label:read',
  ],
};

describe('用户列表', () => {
  it('lists customers from the contract route, with the number masked', async () => {
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: allPermissions });

    expect(await screen.findByText('小明')).toBeInTheDocument();
    expect(screen.getByText('138****8000')).toBeInTheDocument();
    expect(screen.getByText('正常')).toBeInTheDocument();
    expect(screen.getByText('高价值客户')).toBeInTheDocument();

    const list = calls.find((call) => call.url.includes('/admin-api/users?'));
    expect(list?.url).toContain('page=1');
  });

  it('shows the avatar the shopper set, in the list and in the detail drawer', async () => {
    const avatarUrl = 'https://cdn.example.com/2026/09/a1b2c3d4.png';
    stubApi({ ...detail, avatarUrl }, 1, { ...row, avatarUrl });
    renderAdmin(<CustomersPage />, { identity: allPermissions });
    await screen.findByText('小明');
    const avatars = () =>
      Array.from(document.querySelectorAll('.ant-avatar img')).map((img) =>
        img.getAttribute('src'),
      );
    expect(avatars()).toEqual([avatarUrl]);

    await userEvent.click(screen.getByRole('button', { name: '详情' }));
    await waitFor(() => expect(avatars()).toEqual([avatarUrl, avatarUrl]));
  });

  it('keeps 禁用 and 重置密码 behind their own permissions', async () => {
    stubApi();
    renderAdmin(<CustomersPage />, {
      // An operator who may edit a nickname but not end sessions.
      identity: { ...testIdentity, permissions: ['user:customer:read', 'user:customer:write'] },
    });

    await screen.findByText('小明');
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '禁用' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重置密码' })).not.toBeInTheDocument();
  });

  it('新增用户 posts the phone, and leaves out a password nobody typed', async () => {
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: allPermissions });
    await screen.findByText('小明');

    await userEvent.click(screen.getByRole('button', { name: '新增用户' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('手机号'), '13900139000');
    await userEvent.type(within(dialog).getByLabelText('真实姓名'), '王五');
    await userEvent.click(within(dialog).getByRole('button', { name: '保 存' }));

    await waitFor(() => {
      const create = calls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/admin-api/users'),
      );
      expect(create?.body).toEqual({
        phone: '13900139000',
        realName: '王五',
        groupIds: [],
        labelIds: [],
      });
    });
  });

  it('hides 新增用户 from an operator who may only read', async () => {
    stubApi();
    renderAdmin(<CustomersPage />, {
      identity: { ...testIdentity, permissions: ['user:customer:read'] },
    });
    await screen.findByText('小明');
    expect(screen.queryByRole('button', { name: '新增用户' })).not.toBeInTheDocument();
  });

  it('disables through the status sub-resource after asking, not the edit form', async () => {
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: allPermissions });
    await screen.findByText('小明');

    await userEvent.click(screen.getByRole('button', { name: zhName('禁用') }));
    // Asks first, naming the customer; nothing is sent until confirmed.
    const ask = await screen.findByText(/禁用用户「小明」？/);
    expect(calls.some((call) => call.url.includes('/status'))).toBe(false);
    const popup = ask.closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: zhName('禁用') }));

    await waitFor(() => {
      const toggle = calls.find((call) => call.url.includes('/admin-api/users/1001/status'));
      expect(toggle?.method).toBe('POST');
      expect(toggle?.body).toEqual({ status: 'disabled' });
    });
  });

  it('resets a password without ever sending it anywhere but the route', async () => {
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: allPermissions });
    await screen.findByText('小明');

    await userEvent.click(screen.getByRole('button', { name: '重置密码' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('新密码'), 'xzoo654321');
    await userEvent.click(within(dialog).getByRole('button', { name: '确认重置' }));

    await waitFor(() => {
      const reset = calls.find((call) => call.url.includes('/admin-api/users/1001/password'));
      expect(reset?.method).toBe('POST');
      expect(reset?.body).toEqual({ password: 'xzoo654321' });
    });
  });

  it('重置密码 says what is wrong with a short password instead of greying the button out', async () => {
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: allPermissions });
    await screen.findByText('小明');

    await userEvent.click(screen.getByRole('button', { name: '重置密码' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('新密码'), '123');
    await userEvent.click(within(dialog).getByRole('button', { name: '确认重置' }));

    expect(await within(dialog).findByText(/至少.*6/)).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/password'))).toBe(false);
  });

  /**
   * 真实姓名 / 生日 / 管理员备注 live on the detail, not on the list
   * row, so 编辑 used to open them blank — and an empty antd box submits `''`,
   * which `user-admin.service.ts` writes, because it skips a field only when it
   * is `undefined`. Editing a nickname erased the operator's own notes.
   */
  it('loads the whole customer before editing, so the detail-only fields are not erased', async () => {
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: allPermissions });
    await screen.findByText('小明');

    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/admin-api/users/1001'))).toBe(true);
    });

    // Filled from the detail, not blank.
    expect(await within(dialog).findByDisplayValue('王小明')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('老客户，走加急')).toBeInTheDocument();

    await userEvent.clear(within(dialog).getByLabelText('昵称'));
    await userEvent.type(within(dialog).getByLabelText('昵称'), '小明改了名');
    await userEvent.click(within(dialog).getByRole('button', { name: '保 存' }));

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'PUT');
      expect(save?.url).toContain('/admin-api/users/1001');
      expect(save?.body).toMatchObject({
        nickname: '小明改了名',
        realName: '王小明',
        adminRemark: '老客户，走加急',
      });
    });
  });

  it('clears 真实姓名 and 管理员备注 by sending null, the clear the service applies', async () => {
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: allPermissions });
    await screen.findByText('小明');

    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByDisplayValue('王小明');

    await userEvent.clear(within(dialog).getByLabelText('真实姓名'));
    await userEvent.clear(within(dialog).getByDisplayValue('老客户，走加急'));
    await userEvent.click(within(dialog).getByRole('button', { name: '保 存' }));

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'PUT');
      expect(save?.body).toMatchObject({ realName: null, adminRemark: null });
    });
  });

  it('clears 生日 by sending null', async () => {
    const calls = stubApi({ ...detail, birthday: '1990-05-01T00:00:00+08:00' });
    renderAdmin(<CustomersPage />, { identity: allPermissions });
    await screen.findByText('小明');

    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog');
    const picker = (await within(dialog).findByDisplayValue('1990-05-01')).closest('.ant-picker');
    await userEvent.hover(picker as HTMLElement);
    await userEvent.click(picker!.querySelector('.ant-picker-clear') as HTMLElement);
    await userEvent.click(within(dialog).getByRole('button', { name: '保 存' }));

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'PUT');
      expect(save?.body).toMatchObject({ birthday: null });
    });
  });

  it('新增用户 saves when 昵称 and 密码 were typed and then emptied', async () => {
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: allPermissions });
    await screen.findByText('小明');

    await userEvent.click(screen.getByRole('button', { name: '新增用户' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('手机号'), '13900139000');
    for (const label of ['昵称', '登录密码']) {
      await userEvent.type(within(dialog).getByLabelText(label), 'x');
      await userEvent.clear(within(dialog).getByLabelText(label));
    }
    await userEvent.click(within(dialog).getByRole('button', { name: '保 存' }));

    await waitFor(() => {
      const create = calls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/admin-api/users'),
      );
      expect(create?.body).toEqual({ phone: '13900139000', groupIds: [], labelIds: [] });
    });
  });

  it('links the drawer to this customer’s orders and coupons, for a viewer who may read them', async () => {
    stubApi();
    renderAdmin(<CustomersPage />, {
      identity: {
        ...allPermissions,
        permissions: [...allPermissions.permissions, 'order:order:read', 'coupon:user-coupon:read'],
      },
    });
    await screen.findByText('小明');
    await userEvent.click(screen.getByRole('button', { name: '详情' }));

    const orders = await screen.findByRole('link', { name: '查看订单' });
    expect(orders).toHaveAttribute('href', `/admin/orders?userId=${detail.id}`);
    expect(screen.getByRole('link', { name: '查看优惠券' })).toHaveAttribute(
      'href',
      `/admin/coupon/user-coupons?userId=${detail.id}`,
    );
    // No refund:request:read — no link to a list that would answer 403.
    expect(screen.queryByRole('link', { name: '查看售后' })).toBeNull();
  });

  it('fetches the unmasked number only when the detail drawer is opened', async () => {
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: allPermissions });
    await screen.findByText('小明');

    expect(calls.some((call) => call.url.endsWith('/admin-api/users/1001'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: '详情' }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/admin-api/users/1001'))).toBe(true);
    });
  });
});

describe('用户列表 — 发优惠券', () => {
  const marketer = {
    ...testIdentity,
    permissions: ['user:customer:read', 'coupon:grant:write', 'coupon:template:read'],
  };

  async function pickCoupon(dialog: HTMLElement) {
    await userEvent.click(within(dialog).getByRole('combobox', { name: '优惠券' }));
    await userEvent.click(await screen.findByTitle('满 100 减 10'));
  }

  it('hands a coupon to the ticked customers through the grant route', async () => {
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: marketer });
    await screen.findByText('小明');

    await userEvent.click(screen.getAllByRole('checkbox')[1]!);
    await userEvent.click(await screen.findByRole('button', { name: '发优惠券' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/位用户各发放一张/).textContent).toContain('1');
    await pickCoupon(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: '发 放' }));

    await waitFor(() => {
      const grant = calls.find((call) => call.path === '/admin-api/coupons/1/grants');
      expect(grant?.method).toBe('POST');
      expect(grant?.body).toEqual({ userIds: ['1001'] });
    });
    expect(await screen.findByText('已发放 1 张')).toBeInTheDocument();
  });

  it('sends nothing until a coupon is picked', async () => {
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: marketer });
    await screen.findByText('小明');

    await userEvent.click(screen.getAllByRole('checkbox')[1]!);
    await userEvent.click(await screen.findByRole('button', { name: '发优惠券' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '发 放' }));

    expect(await within(dialog).findByText('请选择优惠券')).toBeInTheDocument();
    expect(calls.some((call) => call.path.startsWith('/admin-api/coupons/1/'))).toBe(false);
  });

  it('grants to everyone the filters match, sending the filters, and says when nothing new went out', async () => {
    search = new URLSearchParams('labelId=7&page=2&sortBy=id&sortOrder=desc');
    const calls = stubApi();
    renderAdmin(<CustomersPage />, { identity: marketer });
    await screen.findByText('小明');

    await userEvent.click(await screen.findByRole('button', { name: '给筛选结果发券（1 人）' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/将按当前筛选条件/)).toBeInTheDocument();
    await pickCoupon(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: '发 放' }));

    await waitFor(() => {
      const grant = calls.find((call) => call.path === '/admin-api/coupons/1/grant-batches');
      // The filters, without the page or the sort the list was on.
      expect(grant?.body).toEqual({ filter: { labelId: '7' } });
    });
    // `granted: 0` is not 已发放.
    expect(
      await screen.findByText('没有发出新券：所选用户都已达到每人限领数量'),
    ).toBeInTheDocument();
  });

  it('offers everyone when nothing is filtered, and refuses more than the server would grant', async () => {
    stubApi(detail, 1001);
    renderAdmin(<CustomersPage />, { identity: marketer });
    await screen.findByText('小明');

    expect(await screen.findByRole('button', { name: '给全部用户发券（1001 人）' })).toBeDisabled();
  });

  it('shows neither entry to an operator who may not grant coupons', async () => {
    stubApi();
    renderAdmin(<CustomersPage />, { identity: allPermissions });
    await screen.findByText('小明');

    expect(screen.queryByRole('button', { name: /发券/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('checkbox')[1]!);
    await screen.findByText(/已选择 1 项/);
    expect(screen.queryByRole('button', { name: '发优惠券' })).not.toBeInTheDocument();
  });
});
