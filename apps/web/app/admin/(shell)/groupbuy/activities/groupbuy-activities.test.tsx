import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  groupbuyActivityExample,
  groupbuyActivityOrderExample,
} from '@shop/contracts/groupbuy/schemas';
import {
  groupbuyAdminActivityList,
  groupbuyAdminActivityOrders,
} from '@shop/contracts/groupbuy/groupbuy.admin.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { withStubAssets } from '@/test/asset-source';
import { renderAdmin, testIdentity } from '@/test/render';

import { GroupbuyActivitiesPage } from './groupbuy-activities';

/** Lists retain history and orders; configuration links to 商品编辑. */

function stubApi(orders = [groupbuyActivityOrderExample]): StubCall[] {
  return stubRoutes([
    on(groupbuyAdminActivityOrders, {
      items: orders,
      total: 1,
      page: 1,
      pageSize: 20,
    }),
    on(groupbuyAdminActivityList, {
      items: [groupbuyActivityExample],
      total: 1,
      page: 1,
      pageSize: 20,
    }),
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
    'catalog:product:write',
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
    expect(screen.queryByRole('link', { name: '到商品页设置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    // 订单 needs the group atom, which this admin does not hold either.
    expect(screen.queryByRole('button', { name: '订单' })).not.toBeInTheDocument();
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
  it('links editing to the product page without opening a second activity form', async () => {
    const calls = stubApi();
    renderAdmin(withStubAssets(<GroupbuyActivitiesPage />), { identity: allPermissions });
    const link = await screen.findByRole('link', { name: '编辑' });
    expect(link).toHaveAttribute('href', '/admin/catalog/products/11');
    expect(screen.getByRole('link', { name: '到商品页设置' })).toHaveAttribute(
      'href',
      '/admin/catalog/products',
    );
    expect(screen.queryByRole('button', { name: '暂停' })).toBeNull();
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });
});
