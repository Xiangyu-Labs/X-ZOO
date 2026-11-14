import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  orderAdminDeleteMany,
  orderAdminDetail,
  orderAdminExport,
  orderAdminList,
  orderAdminStatistics,
} from '@shop/contracts/order/order.admin.contract';
import {
  adminOrderDetailExample,
  adminOrderListItemExample,
  orderStatisticsExample,
  type AdminOrderListItem,
} from '@shop/contracts/order/order.fulfil.schemas';
import { expressCompanyPicker } from '@shop/contracts/shipping/shipping.express.contract';
import { expressCompanyListExample } from '@shop/contracts/shipping/schemas';

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
  permissions: [
    'order:order:read',
    'order:order:delete',
    'order:order:export',
    'order:shipment:write',
    'refund:request:read',
  ],
};

function stubApi(
  rows: AdminOrderListItem[] = [adminOrderListItemExample],
  { exportFails = false } = {},
): StubCall[] {
  return stubRoutes([
    on(orderAdminStatistics, orderStatisticsExample),
    on(orderAdminList, { items: rows, total: rows.length, page: 1, pageSize: 20 }),
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
    on(orderAdminDeleteMany, { deleted: 1, skippedIds: ['9003'] }),
    // The 发货 / 物流详情 drawer reads the same detail as the order page.
    on(orderAdminDetail, adminOrderDetailExample),
    on(expressCompanyPicker, expressCompanyListExample),
  ]);
}

const row = (patch: Partial<AdminOrderListItem>): AdminOrderListItem => ({
  ...adminOrderListItemExample,
  ...patch,
});

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

    await userEvent.click(
      screen.getByRole('checkbox', { name: `选择订单 ${adminOrderListItemExample.orderNo}` }),
    );
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

    await userEvent.click(screen.getByRole('tab', { name: zhName('售后中') }));

    expect(navigation.replace).toHaveBeenCalledWith('/admin/orders?page=1&tab=refunding', {
      scroll: false,
    });
  });

  it('售后中 asks for orders with an open refund, not a refund-status roll-up', async () => {
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

  it('a paid 拼团 order still forming is 拼团中, not 发货', async () => {
    stubApi([{ ...adminOrderListItemExample, kind: 'groupbuy', groupbuyTeamStatus: 'forming' }]);
    renderAdmin(<OrdersPage />, { identity: staff });

    expect(await screen.findByText('拼团中')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('发货') })).not.toBeInTheDocument();
  });

  it('labels each order with its type', async () => {
    stubApi([
      row({ id: '9001', orderNo: 'NORMAL-1', kind: 'normal' }),
      row({ id: '9002', orderNo: 'GROUP-1', kind: 'groupbuy' }),
      row({ id: '9003', orderNo: 'PRESALE-1', kind: 'presale' }),
    ]);
    renderAdmin(<OrdersPage />, { identity: staff });

    expect(await screen.findByText('普通')).toBeInTheDocument();
    expect(screen.getByText('拼团')).toBeInTheDocument();
    expect(screen.getByText('预售')).toBeInTheDocument();
  });

  it('shows 买家备注 under an order only when the buyer wrote one', async () => {
    stubApi([
      row({ id: '9001', orderNo: 'NOTE-1', buyerRemark: '请在工作日送达' }),
      row({ id: '9002', orderNo: 'BLANK-1', buyerRemark: '   ' }),
      row({ id: '9003', orderNo: 'NONE-1', buyerRemark: null }),
    ]);
    renderAdmin(<OrdersPage />, { identity: staff });

    expect(await screen.findByText('请在工作日送达')).toBeInTheDocument();
    expect(screen.getAllByText('买家备注')).toHaveLength(1);
  });

  it('offers 发货 on a paid order that still has something to send', async () => {
    stubApi();
    renderAdmin(<OrdersPage />, { identity: staff });

    expect(await screen.findByRole('button', { name: zhName('发货') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('物流详情') })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: zhName('售后详情') })).not.toBeInTheDocument();
  });

  it('offers 物流详情 once the order is shipped, and nothing after completion', async () => {
    stubApi([
      row({
        id: '9001',
        orderNo: 'SHIPPED-1',
        status: 'shipped',
        fulfillmentStatus: 'fulfilled',
        shippedAt: '2026-02-02T09:00:00+08:00',
      }),
    ]);
    const view = renderAdmin(<OrdersPage />, { identity: staff });

    expect(await screen.findByRole('button', { name: zhName('物流详情') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('发货') })).not.toBeInTheDocument();

    view.unmount();
    stubApi([
      row({
        id: '9001',
        orderNo: 'COMPLETED-1',
        status: 'completed',
        fulfillmentStatus: 'fulfilled',
        shippedAt: '2026-02-02T09:00:00+08:00',
      }),
    ]);
    renderAdmin(<OrdersPage />, { identity: staff });

    expect(await screen.findByText('COMPLETED-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('发货') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('物流详情') })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: zhName('售后详情') })).not.toBeInTheDocument();
  });

  it('links 售后详情 to the after-sales list for that order', async () => {
    stubApi([row({ refundStatus: 'requested' })]);
    renderAdmin(<OrdersPage />, { identity: staff });

    const link = await screen.findByRole('link', { name: zhName('售后详情') });
    expect(link).toHaveAttribute(
      'href',
      `/admin/trade/refunds?keyword=${encodeURIComponent(adminOrderListItemExample.orderNo)}`,
    );
    expect(screen.queryByRole('button', { name: zhName('发货') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('物流详情') })).not.toBeInTheDocument();
  });

  it('offers no action on 待付款 and 已退款', async () => {
    stubApi([
      row({
        id: '9001',
        orderNo: 'UNPAID-1',
        status: 'pending_payment',
        paidAmount: null,
        paidAt: null,
        payExpiresAt: '2026-02-01T10:30:00+08:00',
      }),
      row({ id: '9002', orderNo: 'REFUNDED-1', status: 'refunded', refundStatus: 'refunded' }),
    ]);
    renderAdmin(<OrdersPage />, { identity: staff });

    expect(await screen.findByText('UNPAID-1')).toBeInTheDocument();
    expect(screen.getByText('REFUNDED-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('发货') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('物流详情') })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: zhName('售后详情') })).not.toBeInTheDocument();
  });

  it('opens the shipping form from the list', async () => {
    stubApi();
    renderAdmin(<OrdersPage />, { identity: staff });

    await userEvent.click(await screen.findByRole('button', { name: zhName('发货') }));

    expect(await screen.findByText('发货方式')).toBeInTheDocument();
  });

  it('opens the shipment list for 物流详情 without offering 发货', async () => {
    stubApi([
      row({
        status: 'shipped',
        fulfillmentStatus: 'fulfilled',
        shippedAt: '2026-02-02T09:00:00+08:00',
      }),
    ]);
    renderAdmin(<OrdersPage />, { identity: staff });

    await userEvent.click(await screen.findByRole('button', { name: zhName('物流详情') }));

    expect(await screen.findByText('物流信息')).toBeInTheDocument();
    expect(screen.queryByText('发货方式')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('发货') })).not.toBeInTheDocument();
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
