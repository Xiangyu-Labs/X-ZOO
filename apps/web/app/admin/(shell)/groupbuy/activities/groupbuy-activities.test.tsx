import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  groupbuyActivityDetailExample,
  groupbuyActivityExample,
  groupbuyActivityOrderExample,
} from '@shop/contracts/groupbuy/schemas';
import {
  groupbuyAdminActivityDetail,
  groupbuyAdminActivityList,
  groupbuyAdminActivityOrders,
  groupbuyAdminActivitySetStatus,
  groupbuyAdminActivityUpdate,
} from '@shop/contracts/groupbuy/groupbuy.admin.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { withStubAssets } from '@/test/asset-source';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { GroupbuyActivitiesPage } from './groupbuy-activities';

/**
 * The campaign list as a component test: no browser, no server, one stub
 * `fetch`.
 *
 * What is worth asserting on a kit-built page is the wiring — which route the
 * table asks, that permissions really hide the buttons, and what an action puts
 * on the wire. The one thing here that is not generic is the **edit path**: it
 * must read the activity first and send the per-SKU rows back, because
 * rebuilding them on every save is how 已售 would reset.
 */

function stubApi(orders = [groupbuyActivityOrderExample]): StubCall[] {
  return stubRoutes([
    on(groupbuyAdminActivityOrders, {
      items: orders,
      total: 1,
      page: 1,
      pageSize: 20,
    }),
    on(groupbuyAdminActivityDetail, groupbuyActivityDetailExample),
    on(groupbuyAdminActivityList, {
      items: [groupbuyActivityExample],
      total: 1,
      page: 1,
      pageSize: 20,
    }),
    on(groupbuyAdminActivityUpdate, groupbuyActivityDetailExample),
    on(groupbuyAdminActivitySetStatus, { ...groupbuyActivityDetailExample, status: 'paused' }),
  ]);
}

// The 状态 column reads the window against the clock, so the clock is pinned
// inside the example's 2026-09-01 – 2026-10-31 window. Only `Date` is faked.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T12:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
  resetApiConfig();
});

const allPermissions = {
  ...testIdentity,
  permissions: [
    'groupbuy:activity:read',
    'groupbuy:activity:write',
    'groupbuy:activity:delete',
    'groupbuy:group:read',
  ],
};

describe('拼团活动', () => {
  it('lists campaigns from the contract route', async () => {
    const calls = stubApi();
    renderAdmin(withStubAssets(<GroupbuyActivitiesPage />), { identity: allPermissions });

    expect(await screen.findByText('三人成团 · 坚果礼盒')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('3 人')).toBeInTheDocument();
    // 还在拼 links to the teams of this campaign, not to its orders.
    expect(screen.getByRole('link', { name: '4 个团' })).toHaveAttribute(
      'href',
      '/admin/groupbuy/groups?activityId=1&status=forming',
    );
    expect(calls[0]?.url).toContain('/admin-api/groupbuy-activities?');
    expect(calls[0]?.url).toContain('page=1');
  });

  it('hides every write action from a read-only admin', async () => {
    stubApi();
    renderAdmin(withStubAssets(<GroupbuyActivitiesPage />), {
      identity: { ...testIdentity, permissions: ['groupbuy:activity:read'] },
    });

    await screen.findByText('三人成团 · 坚果礼盒');
    expect(screen.queryByRole('button', { name: '新建拼团活动' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    // 订单 needs the group atom, which this admin does not hold either.
    expect(screen.queryByRole('button', { name: '订单' })).not.toBeInTheDocument();
  });

  it('pauses through the status sub-resource, not the edit form', async () => {
    const calls = stubApi();
    renderAdmin(withStubAssets(<GroupbuyActivitiesPage />), { identity: allPermissions });
    await screen.findByText('三人成团 · 坚果礼盒');

    await userEvent.click(screen.getByRole('button', { name: '暂停' }));
    // Switching off is customer-visible, so it asks first.
    const popup = (await screen.findByText(/^暂停拼团「/)).closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: zhName('暂停') }));

    await waitFor(() => {
      const toggle = calls.find((call) => call.method === 'POST');
      expect(toggle?.url).toContain('/admin-api/groupbuy-activities/1/status');
      expect(toggle?.body).toEqual({ status: 'paused' });
    });
  });

  it('reads the activity before editing it, and sends the SKU rows back', async () => {
    const calls = stubApi();
    renderAdmin(withStubAssets(<GroupbuyActivitiesPage />), { identity: allPermissions });
    await screen.findByText('三人成团 · 坚果礼盒');

    await userEvent.click(screen.getByRole('button', { name: '编辑' }));

    // The dialog is mounted only once the detail has arrived — a form seeded
    // from the list row would have an empty 规格 list and the save would wipe
    // every per-SKU price.
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/admin-api/groupbuy-activities/1'))).toBe(
        true,
      );
    });
    const dialog = await screen.findByRole('dialog');
    await screen.findByDisplayValue('三人成团 · 坚果礼盒');

    await userEvent.click(within(dialog).getByRole('button', { name: '保 存' }));

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'PUT');
      expect(save?.url).toContain('/admin-api/groupbuy-activities/1');
      expect(save?.body).toMatchObject({
        title: '三人成团 · 坚果礼盒',
        // A decimal-string id, as the contract wants — not the number a
        // numeric control would hand it.
        productId: groupbuyActivityDetailExample.productId,
        seatsRequired: 3,
        groupTtlSeconds: 86400,
        skus: [{ skuId: '21', price: '59.00', stock: 200, quota: 500, isEnabled: true }],
      });
      // `sales` is the server's; the form never sends it back.
      expect(save?.body).not.toHaveProperty('sales');
    });
  });

  it('says 未开始 for an active campaign before its start, not 进行中', async () => {
    vi.setSystemTime(new Date('2026-08-01T12:00:00+08:00'));
    stubApi();
    renderAdmin(withStubAssets(<GroupbuyActivitiesPage />), { identity: allPermissions });

    expect(await screen.findByText('未开始')).toBeInTheDocument();
    expect(screen.queryByText('进行中')).not.toBeInTheDocument();
  });

  it('opens the campaign orders through the nested route', async () => {
    const calls = stubApi();
    renderAdmin(withStubAssets(<GroupbuyActivitiesPage />), { identity: allPermissions });
    await screen.findByText('三人成团 · 坚果礼盒');

    await userEvent.click(screen.getByRole('button', { name: '订单' }));

    expect(await screen.findByText('202609221000000000000002')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        calls.some((call) => call.url.includes('/admin-api/groupbuy-activities/1/orders')),
      ).toBe(true);
    });
    expect(screen.getByText('小红')).toBeInTheDocument();
  });

  it('names a member with no nickname (never set, or 注销) by the account', async () => {
    stubApi([{ ...groupbuyActivityOrderExample, nickname: null }]);
    renderAdmin(withStubAssets(<GroupbuyActivitiesPage />), { identity: allPermissions });
    await screen.findByText('三人成团 · 坚果礼盒');

    await userEvent.click(screen.getByRole('button', { name: '订单' }));

    expect(await screen.findByText('用户 #102')).toBeInTheDocument();
  });
});
