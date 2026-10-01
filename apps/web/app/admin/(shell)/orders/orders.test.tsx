import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  orderAdminDeleteMany,
  orderAdminExport,
  orderAdminList,
  orderAdminStatistics,
} from '@shop/contracts/order/order.admin.contract';
import {
  adminOrderListItemExample,
  orderStatisticsExample,
  type AdminOrderListItem,
} from '@shop/contracts/order/order.fulfil.schemas';

import { setApiFeedback } from '@/admin/api';
import { resetApiConfig } from '@/admin/api/config';
import { on, respondWithError, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { OrdersPage } from './orders';

const feedback = { error: vi.fn(), success: vi.fn() };

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  search: '',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: navigation.replace,
    push: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/admin/orders',
  useSearchParams: () => new URLSearchParams(navigation.search),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

const staff = {
  ...testIdentity,
  permissions: ['order:order:read', 'order:order:delete', 'order:order:export'],
};

function stubApi(
  rows: AdminOrderListItem[] = [adminOrderListItemExample],
  { exportFails = false } = {},
): StubCall[] {
  return stubRoutes([
    on(orderAdminStatistics, orderStatisticsExample),
    on(orderAdminList, { items: rows, total: rows.length, page: 1, pageSize: 20 }),
    on(orderAdminDeleteMany, { deleted: 1, skippedIds: ['9003'] }),
    on(orderAdminExport, () =>
      exportFails
        ? respondWithError(422, { code: 'VALIDATION_FAILED', message: '筛选条件无效' })
        : {
            filename: '订单.csv',
            contentType: 'text/csv' as const,
            content: '',
            rowCount: 0,
            truncated: false,
          },
    ),
  ]);
}

beforeEach(() => {
  navigation.replace.mockClear();
  navigation.search = '';
  feedback.error.mockClear();
  feedback.success.mockClear();
  // What `ApiFeedbackBridge` installs in the real shell: the toasts.
  setApiFeedback(feedback);
});

afterEach(() => {
  setApiFeedback(null);
  resetApiConfig();
});

describe('订单列表', () => {
  it('批量删除 says how many were deleted and how many were skipped', async () => {
    stubApi();
    renderAdmin(<OrdersPage />, { identity: staff });
    await screen.findByText(adminOrderListItemExample.orderNo);

    const boxes = screen.getAllByRole('checkbox');
    await userEvent.click(boxes[boxes.length - 1] as HTMLElement);
    await userEvent.click(await screen.findByRole('button', { name: zhName('批量删除') }));
    await userEvent.click(await screen.findByRole('button', { name: zhName('确定') }));

    await waitFor(() =>
      expect(feedback.success).toHaveBeenCalledWith(
        '已删除 1 个订单，跳过 1 个未完成或有售后在处理的订单',
      ),
    );
  });

  it('shows the work queue only to a role that may read 订单统计', async () => {
    const calls = stubApi();
    renderAdmin(<OrdersPage />, { identity: staff });
    await screen.findByText(adminOrderListItemExample.orderNo);
    expect(screen.queryByText('近 30 天实付')).toBeNull();
    expect(calls.some((call) => call.url.includes('/admin-api/orders/statistics'))).toBe(false);
    expect(feedback.error).not.toHaveBeenCalled();
  });

  it('a role with 订单统计 sees the work queue', async () => {
    const calls = stubApi();
    renderAdmin(<OrdersPage />, {
      identity: { ...staff, permissions: [...staff.permissions, 'order:stats:read'] },
    });
    expect(await screen.findByText('近 30 天实付')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/admin-api/orders/statistics'))).toBe(true);
  });

  it('a tab change goes back to page 1 and keeps the tab in the URL', async () => {
    navigation.search = 'page=3';
    stubApi();
    renderAdmin(<OrdersPage />, { identity: staff });
    await screen.findByText(adminOrderListItemExample.orderNo);

    await userEvent.click(screen.getByRole('tab', { name: zhName('退款中') }));

    expect(navigation.replace).toHaveBeenCalledWith('/admin/orders?page=1&tab=refunding', {
      scroll: false,
    });
  });

  it('退款中 asks for orders with an open refund, not a refund-status roll-up', async () => {
    navigation.search = 'tab=refunding';
    const calls = stubApi();
    renderAdmin(<OrdersPage />, { identity: staff });
    await screen.findByText(adminOrderListItemExample.orderNo);

    const list = calls.find((call) => call.routeId === orderAdminList.id);
    expect(list?.query.get('refunding')).toBe('true');
    expect(list?.query.has('refundStatus')).toBe(false);
  });

  it('the detail link carries the list it came from', async () => {
    navigation.search = 'tab=unshipped&page=2';
    stubApi();
    renderAdmin(<OrdersPage />, { identity: staff });

    const link = await screen.findByRole('link', { name: adminOrderListItemExample.orderNo });
    expect(link.getAttribute('href')).toBe(
      `/admin/orders/${adminOrderListItemExample.id}?list=${encodeURIComponent('tab=unshipped&page=2')}`,
    );
  });

  it('a paid 拼团 order still forming is 拼团中, not 去发货', async () => {
    stubApi([{ ...adminOrderListItemExample, kind: 'groupbuy', groupbuyTeamStatus: 'forming' }]);
    renderAdmin(<OrdersPage />, { identity: staff });

    expect(await screen.findByText('拼团中')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('去发货') })).not.toBeInTheDocument();
  });

  it('exports with the filter bar applied and shows a refused export', async () => {
    navigation.search = 'keyword=13800';
    const calls = stubApi([adminOrderListItemExample], { exportFails: true });
    renderAdmin(<OrdersPage />, { identity: staff });
    await screen.findByText(adminOrderListItemExample.orderNo);

    await userEvent.click(screen.getByRole('button', { name: zhName('导出 CSV') }));

    await waitFor(() =>
      expect(feedback.error).toHaveBeenCalledWith(
        expect.objectContaining({ message: '筛选条件无效' }),
      ),
    );
    const exported = calls.find((call) => call.routeId === orderAdminExport.id);
    expect(exported?.query.get('keyword')).toBe('13800');
  });
});
