import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  orderAdminDetail,
  orderAdminShip,
  orderAdminTimeline,
  orderAdminUpdateAddress,
  orderAdminUpdateShipment,
} from '@shop/contracts/order/order.admin.contract';
import {
  adminOrderDetailExample,
  shipmentExample,
  type AdminOrderDetail,
} from '@shop/contracts/order/order.fulfil.schemas';
import { expressCompanyPicker } from '@shop/contracts/shipping/shipping.express.contract';
import { cityTreeExample, expressCompanyListExample } from '@shop/contracts/shipping/schemas';
import { cityTreePublic } from '@shop/contracts/shipping/shipping.city.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, respondWithError, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { listHrefOf, OrderDetailPage } from './order-detail';

const staff = {
  ...testIdentity,
  permissions: ['order:order:read', 'order:order:write', 'order:shipment:write'],
};

function stubApi(order: AdminOrderDetail | 'missing' = adminOrderDetailExample): StubCall[] {
  return stubRoutes([
    on(orderAdminDetail, () =>
      order === 'missing'
        ? respondWithError(404, { code: 'ORDER_NOT_FOUND', message: '订单不存在' })
        : order,
    ),
    on(orderAdminTimeline, { items: [] }),
    on(expressCompanyPicker, expressCompanyListExample),
    on(orderAdminShip, shipmentExample),
    on(orderAdminUpdateShipment, shipmentExample),
    on(orderAdminUpdateAddress, order === 'missing' ? adminOrderDetailExample : order),
    on(cityTreePublic, cityTreeExample),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

describe('订单详情', () => {
  it('返回 rebuilds the list the operator came from, and nothing else', () => {
    expect(listHrefOf('tab=unshipped&page=2')).toBe('/admin/orders?tab=unshipped&page=2');
    expect(listHrefOf(null)).toBe('/admin/orders');
    // Only ever a query on the order list: a path in `?list=` stays a query.
    expect(listHrefOf('//evil.example/x')).toMatch(/^\/admin\/orders\?/);
  });

  it('says the order failed to load instead of showing an empty page', async () => {
    stubApi('missing');
    renderAdmin(<OrderDetailPage id="9001" />, { identity: staff });

    expect(await screen.findByText('订单加载失败')).toBeInTheDocument();
    expect(screen.getByText('订单不存在')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: zhName('重试') })).toBeInTheDocument();
  });

  it('names the tab after the order and links what the viewer may open', async () => {
    const item = adminOrderDetailExample.items[0]!;
    stubApi({ ...adminOrderDetailExample, refundStatus: 'partially_refunded' });
    renderAdmin(<OrderDetailPage id="9001" />, {
      identity: { ...staff, permissions: [...staff.permissions, 'catalog:product:read'] },
    });

    expect(await screen.findByRole('link', { name: item.productName })).toHaveAttribute(
      'href',
      `/admin/catalog/products/${item.productId}`,
    );
    await waitFor(() => expect(document.title).toContain(adminOrderDetailExample.orderNo));
    // No refund:request:read: the status is shown, not a link to a page that refuses them.
    expect(screen.getByText('部分退款').closest('a')).toBeNull();
  });

  it('修改地址 picks 省市区 from the tree and sends them as three names', async () => {
    const calls = stubApi({ ...adminOrderDetailExample, status: 'paid' });
    renderAdmin(<OrderDetailPage id="9001" />, { identity: staff });

    await userEvent.click(await screen.findByRole('button', { name: '修改地址' }));
    const dialog = await screen.findByRole('dialog');
    // The address as it is now, in the picker.
    expect(within(dialog).getByText('浙江省 / 杭州市 / 西湖区')).toBeInTheDocument();

    const option = (name: string) =>
      waitFor(() => {
        const item = document.querySelector(`.ant-cascader-menu-item[title="${name}"]`);
        expect(item).not.toBeNull();
        return item as HTMLElement;
      });
    await userEvent.click(within(dialog).getByRole('combobox'));
    for (const name of ['北京', '北京市', '东城区']) await userEvent.click(await option(name));
    await userEvent.click(within(dialog).getByRole('button', { name: zhName('保存') }));

    await waitFor(() => {
      const put = calls.find((call) => call.routeId === orderAdminUpdateAddress.id);
      expect(put?.body).toMatchObject({ province: '北京', city: '北京市', district: '东城区' });
    });
  });

  it('a 拼团 order still forming offers no 发货', async () => {
    stubApi({ ...adminOrderDetailExample, kind: 'groupbuy', groupbuyTeamStatus: 'forming' });
    renderAdmin(<OrderDetailPage id="9001" />, { identity: staff });

    expect(await screen.findByText('拼团中，成团后才能发货')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('发货') })).not.toBeInTheDocument();
  });

  it('every quantity at 0 is refused in the form, not sent as 「全部发出」', async () => {
    const calls = stubApi();
    renderAdmin(<OrderDetailPage id="9001" />, { identity: staff });

    await userEvent.click(await screen.findByRole('button', { name: zhName('发货') }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByText('虚拟发货'));
    await userEvent.type(within(dialog).getByRole('textbox'), '已线下交付');
    const quantity = within(dialog).getByRole('spinbutton');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '0');
    await userEvent.click(within(dialog).getByRole('button', { name: zhName('保存') }));

    expect(await within(dialog).findByText('至少发出一件商品')).toBeInTheDocument();
    expect(calls.some((call) => call.routeId === orderAdminShip.id)).toBe(false);
  });

  it('修改物流 corrects the waybill of a dispatched shipment', async () => {
    const calls = stubApi({
      ...adminOrderDetailExample,
      status: 'shipped',
      fulfillmentStatus: 'fulfilled',
      shipments: [shipmentExample],
    });
    renderAdmin(<OrderDetailPage id="9001" />, { identity: staff });

    await userEvent.click(await screen.findByRole('button', { name: zhName('修改物流') }));
    const dialog = await screen.findByRole('dialog');
    const tracking = await within(dialog).findByDisplayValue(shipmentExample.trackingNo!);
    await userEvent.clear(tracking);
    await userEvent.type(tracking, 'SF9999999999999');
    await userEvent.click(within(dialog).getByRole('button', { name: zhName('保存') }));

    await waitFor(() => {
      const patch = calls.find((call) => call.routeId === orderAdminUpdateShipment.id);
      expect(patch?.params).toEqual({ id: shipmentExample.id });
      expect(patch?.body).toMatchObject({ trackingNo: 'SF9999999999999' });
    });
    // A fully shipped order cannot be un-shipped from here.
    expect(screen.queryByRole('button', { name: zhName('撤销') })).not.toBeInTheDocument();
  });
});
