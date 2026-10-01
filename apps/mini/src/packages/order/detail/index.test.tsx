import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { orderDetail, orderItem, shipment } from '@/test/order-fixtures';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import OrderDetailPage from './index';

describe('订单详情', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
  });

  it('shows an unpaid order with its time left, the amounts and 立即付款', async () => {
    taroFake.routerParams = { id: '9001' };
    serveApi({
      'GET /api/v1/orders/9001': () => ({
        body: orderDetail({
          status: 'pending_payment',
          paidAmount: null,
          paidAt: null,
          payExpiresAt: '2099-01-01T00:00:00+08:00',
          itemsAmount: '120.00',
          freightAmount: '8.00',
          couponDiscount: '10.00',
          payableAmount: '118.00',
          items: [orderItem('7001', { productName: '按摩精油' })],
        }),
      }),
    });
    await renderPage(<OrderDetailPage />);

    await screen.findByText('等待付款');
    expect(screen.getByText(/未付款将自动取消/)).toBeTruthy();
    expect(screen.getByText('按摩精油')).toBeTruthy();
    expect(screen.getByLabelText('价格 118 元')).toBeTruthy();
    expect(screen.getByText('应付款')).toBeTruthy();
    expect(screen.getByText('138****8000', { exact: false })).toBeTruthy();
    // No 发票 before paying.
    expect(screen.queryByText('申请开票')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '立即付款' }));
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/order/cashier/index?orderId=9001' },
    });
  });

  it('opens by the payment number from a WeChat message', async () => {
    taroFake.routerParams = { outTradeNo: 'P123' };
    const seen = serveApi({
      'GET /api/v1/payments/P123': () => ({
        body: { outTradeNo: 'P123', orderId: '9001', status: 'paid', paid: true, paidAt: null },
      }),
      'GET /api/v1/orders/9001': () => ({ body: orderDetail() }),
    });
    await renderPage(<OrderDetailPage />);
    await screen.findByText('等待发货');
    expect(seen.map((r) => r.key)).toEqual([
      'GET /api/v1/payments/P123',
      'GET /api/v1/orders/9001',
    ]);
  });

  it('shows the parcels of a shipped order and confirms receipt from the bar', async () => {
    taroFake.routerParams = { id: '9001' };
    const shipped = orderDetail({
      status: 'shipped',
      fulfillmentStatus: 'fulfilled',
      shippedAt: '2026-02-02T09:00:00+08:00',
    });
    const seen = serveApi({
      'GET /api/v1/orders/9001': () => ({ body: shipped }),
      'GET /api/v1/orders/9001/shipments': () => ({ body: { items: [shipment('4001')] } }),
      'GET /api/v1/orders/9001/wechat-receipt': () => ({ body: { receipt: null } }),
      'POST /api/v1/orders/9001/receipt': () => ({ body: { ...shipped, status: 'received' } }),
    });
    await renderPage(<OrderDetailPage />);

    await screen.findByText('顺丰速运 SF4001');
    fireEvent.click(screen.getByRole('link', { name: '查看物流' }));
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/order/logistics/index?orderId=9001' },
    });
    // 查看物流 is the parcel row, not a second button in the bar.
    expect(screen.queryByRole('button', { name: '查看物流' })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: '申请售后' }));
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/aftersale/apply/index?orderId=9001' },
    });

    fireEvent.click(screen.getByRole('button', { name: '确认收货' }));
    await waitFor(() =>
      expect(seen.map((r) => r.key)).toContain('POST /api/v1/orders/9001/receipt'),
    );
  });

  it('goes back after deleting a finished order', async () => {
    taroFake.routerParams = { id: '9001' };
    taroFake.pageStackDepth = 2;
    const seen = serveApi({
      'GET /api/v1/orders/9001': () => ({
        body: orderDetail({ status: 'cancelled', paidAmount: null, cancelReason: '超时未支付' }),
      }),
      'DELETE /api/v1/orders/9001': () => ({ body: { hidden: true } }),
      'GET /api/v1/orders': () => ({ body: { items: [], total: 0, page: 1, pageSize: 10 } }),
    });
    await renderPage(<OrderDetailPage />);
    await screen.findByText('超时未支付');

    fireEvent.click(screen.getByRole('button', { name: '删除订单' }));
    await waitFor(() => expect(taroFake.calls.some((c) => c.api === 'navigateBack')).toBe(true));
    expect(seen.map((r) => r.key)).toContain('DELETE /api/v1/orders/9001');
  });

  it('copies the order number', async () => {
    taroFake.routerParams = { id: '9001' };
    serveApi({ 'GET /api/v1/orders/9001': () => ({ body: orderDetail() }) });
    await renderPage(<OrderDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '复制订单编号' }));
    expect(taroFake.calls).toContainEqual({
      api: 'setClipboardData',
      args: { data: '202602011000000010123456' },
    });
  });

  it('prints a presale line at its activity price and only the coupon as 优惠券', async () => {
    taroFake.routerParams = { id: '9001' };
    serveApi({
      'GET /api/v1/orders/9001': () => ({
        body: orderDetail({
          kind: 'presale',
          status: 'pending_payment',
          paidAmount: null,
          paidAt: null,
          itemsAmount: '88.00',
          couponDiscount: '15.00',
          payableAmount: '73.00',
          userCouponId: '31',
          items: [
            orderItem('7001', {
              productName: '预售商品',
              unitPrice: '88.00',
              discountAmount: '15.00',
              totalAmount: '73.00',
              adjustments: [
                { source: 'presale:activity-price', label: '预售价', amount: '-10.00' },
                { source: 'coupon:discount', label: '叠加券', amount: '-5.00' },
              ],
            }),
          ],
        }),
      }),
    });
    await renderPage(<OrderDetailPage />);
    await screen.findByText('预售商品');
    const page = document.querySelector('#order-detail')!;
    expect(page.textContent).toContain('¥78.00×1');
    expect(page.textContent).toContain('商品金额¥78.00');
    expect(page.textContent).toContain('优惠券-¥5.00');
    expect(page.textContent).toContain('应付款¥73.00');
    expect(page.textContent).not.toContain('88.00');
  });

  it('links a group-buy order to its team', async () => {
    taroFake.routerParams = { id: '9001' };
    serveApi({
      'GET /api/v1/orders/9001': () => ({
        body: orderDetail({ kind: 'groupbuy', groupbuyTeamId: '501' }),
      }),
    });
    await renderPage(<OrderDetailPage />);
    fireEvent.click(await screen.findByRole('link', { name: '查看拼团' }));
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/promo/groupbuy-team/index?id=501' },
    });
  });

  it('says 拼团中 with the seats left while the team forms, and offers 申请开票 only when the server takes it', async () => {
    taroFake.routerParams = { id: '9001' };
    serveApi({
      'GET /api/v1/orders/9001': () => ({
        body: orderDetail({
          kind: 'groupbuy',
          groupbuyTeamId: '501',
          groupbuyTeam: {
            id: '501',
            status: 'forming',
            role: 'leader',
            seatsTotal: 3,
            seatsTaken: 1,
            expiresAt: '2099-01-01T00:00:00+08:00',
          },
          // Already asked for, say: the server no longer takes a request.
          invoiceRequestable: false,
        }),
      }),
    });
    await renderPage(<OrderDetailPage />);
    await screen.findByText('拼团中');
    expect(screen.getByText('还差 2 人成团，成团后发货')).toBeTruthy();
    expect(screen.queryByText('等待发货')).toBeNull();
    expect(screen.queryByText('申请开票')).toBeNull();
  });

  it('offers 申请开票 on a paid order the server would invoice', async () => {
    taroFake.routerParams = { id: '9001' };
    serveApi({ 'GET /api/v1/orders/9001': () => ({ body: orderDetail() }) });
    await renderPage(<OrderDetailPage />);
    fireEvent.click(await screen.findByText('申请开票'));
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/account/invoice-apply/index?orderId=9001' },
    });
  });

  it('has no team link for any other order', async () => {
    taroFake.routerParams = { id: '9001' };
    serveApi({ 'GET /api/v1/orders/9001': () => ({ body: orderDetail() }) });
    await renderPage(<OrderDetailPage />);
    await screen.findByText('等待发货');
    expect(screen.queryByText('查看拼团')).toBeNull();
  });

  it("re-reads the order when the shopper is back from WeChat's component without an answer", async () => {
    taroFake.routerParams = { id: '9001' };
    taroFake.businessViewStatus = 'hang';
    const shipped = orderDetail({
      status: 'shipped',
      fulfillmentStatus: 'fulfilled',
      shippedAt: '2026-02-02T09:00:00+08:00',
    });
    // WeChat told the server itself (trade_manage_order_settlement) while the app was away.
    let reads = 0;
    serveApi({
      'GET /api/v1/orders/9001': () => {
        reads += 1;
        return { body: reads === 1 ? shipped : { ...shipped, status: 'received' } };
      },
      'GET /api/v1/orders/9001/shipments': () => ({ body: { items: [shipment('4001')] } }),
      'GET /api/v1/orders/9001/wechat-receipt': () => ({
        body: { receipt: { transactionId: '4200' } },
      }),
      'POST /api/v1/orders/9001/receipt': () => ({
        status: 409,
        body: { code: 'ORDER_NOT_RECEIVABLE', message: '订单当前无法确认收货' },
      }),
    });
    await renderPage(<OrderDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '确认收货' }));
    await waitFor(() =>
      expect(taroFake.calls.map((call) => call.api)).toContain('openBusinessView'),
    );

    taroFake.showApp({});
    await screen.findByText('已收货', undefined, { timeout: 4000 });
    // Nothing went wrong from the shopper's side: no error toast.
    expect(taroFake.calls.some((call) => call.api === 'showToast')).toBe(false);
  });
});
