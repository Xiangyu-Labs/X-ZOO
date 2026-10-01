import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { orderDetail, orderItem, orderListItem, paged } from '@/test/order-fixtures';
import { renderPage } from '@/test/render';
import { routeQueryKey } from '@shop/api-client/react';
import { taroFake } from '@/test/taro-fake/taro';
import OrderListPage from './index';

const counts = {
  all: 4,
  unpaid: 1,
  unshipped: 2,
  unreceived: 1,
  finished: 0,
  cancelled: 0,
  refunding: 0,
  unreviewed: 3,
};

/** The `tab` of every order-list request, in order. */
function requestedTabs(): string[] {
  return taroFake.calls
    .filter((call) => call.api === 'request')
    .map((call) => (call.args as { url: string }).url)
    .filter((url) => /\/api\/v1\/orders\?/.test(url))
    .map((url) => new URL(url, 'https://x').searchParams.get('tab') ?? '');
}

describe('我的订单', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on the tab it was sent to, with the counts of what waits', async () => {
    taroFake.routerParams = { tab: 'unshipped' };
    serveApi({
      'GET /api/v1/orders/counts': () => ({ body: counts }),
      'GET /api/v1/orders': () => ({ body: paged([orderListItem()]) }),
    });
    await renderPage(<OrderListPage />);

    await screen.findByText('订单号 202602011000000010123456');
    expect(screen.getByRole('tab', { name: '待发货 2' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: '待付款 1' })).toBeTruthy();
    expect(requestedTabs()).toEqual(['unshipped']);
  });

  it('loads the other tab when one is tapped, and says when it is empty', async () => {
    serveApi({
      'GET /api/v1/orders/counts': () => ({ body: counts }),
      'GET /api/v1/orders': () => ({ body: paged([]) }),
    });
    await renderPage(<OrderListPage />);
    await screen.findByText('还没有订单');

    fireEvent.click(screen.getByRole('tab', { name: '已取消' }));
    await screen.findByText('没有已取消的订单');
    expect(requestedTabs()).toEqual(['all', 'cancelled']);
  });

  it('coming back to a stale list, asks for page 1 only and keeps the pages scrolled through', async () => {
    let round = 0;
    const seen = serveApi({
      'GET /api/v1/orders/counts': () => ({ body: counts }),
      'GET /api/v1/orders': () => {
        const page = Number(seen.at(-1)?.query.page);
        if (page === 1) round += 1;
        const ids = page === 1 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [11, 12];
        const items = ids.map((n) =>
          orderListItem({
            id: String(9000 + n),
            orderNo: n === 1 ? `R${round}-000${n}` : `000${n}`,
          }),
        );
        return { body: paged(items, 12, page) };
      },
    });
    await renderPage(<OrderListPage />);
    await screen.findByText('订单号 R1-0001');
    taroFake.reachBottom();
    await screen.findByText('订单号 00012');
    const pages = () => seen.filter((r) => r.key === 'GET /api/v1/orders').map((r) => r.query.page);
    expect(pages()).toEqual(['1', '2']);

    // Back from another page after the 30 s staleTime (the test client's is 0).
    taroFake.showPage();
    await screen.findByText('订单号 R2-0001');
    expect(pages()).toEqual(['1', '2', '1']);
    expect(screen.getByText('订单号 00012')).toBeTruthy();
  });

  it('coming back after 5 minutes away, reloads every page from page 1', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let round = 0;
    const seen = serveApi({
      'GET /api/v1/orders/counts': () => ({ body: counts }),
      'GET /api/v1/orders': () => {
        const page = Number(seen.at(-1)?.query.page);
        if (page === 1) round += 1;
        const ids = page === 1 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [11, 12];
        const items = ids.map((n) =>
          orderListItem({
            id: String(9000 + n),
            orderNo: n === 1 || n === 12 ? `R${round}-000${n}` : `000${n}`,
          }),
        );
        return { body: paged(items, 12, page) };
      },
    });
    await renderPage(<OrderListPage />);
    await screen.findByText('订单号 R1-0001');
    taroFake.reachBottom();
    await screen.findByText('订单号 R1-00012');

    taroFake.hidePage();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    taroFake.showPage();
    await screen.findByText('订单号 R2-00012');
    const pages = () => seen.filter((r) => r.key === 'GET /api/v1/orders').map((r) => r.query.page);
    expect(pages()).toEqual(['1', '2', '1', '2']);
    expect(screen.getByText('订单号 R2-0001')).toBeTruthy();
  });

  it('lists the orders still to review under 待评价, with its count, and offers 去评价', async () => {
    taroFake.routerParams = { tab: 'unreviewed' };
    serveApi({
      'GET /api/v1/orders/counts': () => ({ body: counts }),
      'GET /api/v1/orders': () => ({
        body: paged([
          orderListItem({
            status: 'completed',
            fulfillmentStatus: 'fulfilled',
            items: [orderItem('7001', { reviewable: true })],
          }),
        ]),
      }),
    });
    await renderPage(<OrderListPage />);

    fireEvent.click(await screen.findByRole('button', { name: '去评价' }));
    expect(screen.getByRole('tab', { name: '待评价 3' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText('待评价', { selector: '.shop-order__status' })).toBeTruthy();
    expect(requestedTabs()).toEqual(['unreviewed']);
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/order/review/index?orderId=9001' },
    });
  });

  it('cancels an unpaid order after asking, and refreshes the list', async () => {
    const unpaid = orderListItem({
      status: 'pending_payment',
      paidAmount: null,
      payExpiresAt: '2099-01-01T00:00:00+08:00',
    });
    const seen = serveApi({
      'GET /api/v1/orders/counts': () => ({ body: counts }),
      'GET /api/v1/orders': () => ({ body: paged([unpaid]) }),
      'POST /api/v1/orders/9001/cancel': () => ({
        body: orderDetail({ ...unpaid, status: 'cancelled' }),
      }),
    });
    const { client } = await renderPage(<OrderListPage />);
    const wallet = routeQueryKey('coupon.myList', { query: { state: 'unused' } });
    client.setQueryData(wallet, { items: [], page: 1, pageSize: 20, total: 0 });
    const teams = routeQueryKey('groupbuy.myGroups', { query: {} });
    client.setQueryData(teams, { items: [], page: 1, pageSize: 20, total: 0 });
    const home = routeQueryKey('decor.pageHome');
    client.setQueryData(home, {});

    fireEvent.click(await screen.findByRole('button', { name: '取消订单' }));
    await waitFor(() =>
      expect(seen.map((r) => r.key)).toContain('POST /api/v1/orders/9001/cancel'),
    );
    expect(taroFake.calls.find((call) => call.api === 'showModal')?.args).toMatchObject({
      content: '确定取消这个订单吗？取消后需重新下单。',
    });
    await waitFor(() =>
      expect(seen.filter((r) => r.key === 'GET /api/v1/orders').length).toBeGreaterThan(1),
    );
    // Its coupon is back in the wallet, and a 拼团 order's seat is free again.
    expect(client.getQueryState(wallet)?.isInvalidated).toBe(true);
    expect(client.getQueryState(teams)?.isInvalidated).toBe(true);
    // 首页's coupon blocks and 订单入口 change too.
    expect(client.getQueryState(home)?.isInvalidated).toBe(true);
  });

  it('keeps the order when the shopper backs out of cancelling', async () => {
    taroFake.modalConfirm = false;
    const seen = serveApi({
      'GET /api/v1/orders/counts': () => ({ body: counts }),
      'GET /api/v1/orders': () => ({
        body: paged([orderListItem({ status: 'pending_payment', paidAmount: null })]),
      }),
    });
    await renderPage(<OrderListPage />);
    fireEvent.click(await screen.findByRole('button', { name: '取消订单' }));
    await waitFor(() => expect(taroFake.calls.some((c) => c.api === 'showModal')).toBe(true));
    expect(seen.some((r) => r.key.startsWith('POST'))).toBe(false);
  });

  it('goes to the cashier to pay, and confirms receipt on a shipped order', async () => {
    const seen = serveApi({
      'GET /api/v1/orders/counts': () => ({ body: counts }),
      'GET /api/v1/orders': () => ({
        body: paged([
          orderListItem({ id: '1', orderNo: 'A1', status: 'pending_payment', paidAmount: null }),
          orderListItem({ id: '2', orderNo: 'A2', status: 'shipped' }),
        ]),
      }),
      'GET /api/v1/orders/2/wechat-receipt': () => ({ body: { receipt: null } }),
      'POST /api/v1/orders/2/receipt': () => ({
        body: orderDetail({ id: '2', status: 'received' }),
      }),
    });
    await renderPage(<OrderListPage />);

    fireEvent.click(await screen.findByRole('button', { name: '立即付款' }));
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/order/cashier/index?orderId=1' },
    });

    fireEvent.click(screen.getByRole('button', { name: '确认收货' }));
    await waitFor(() => expect(seen.map((r) => r.key)).toContain('POST /api/v1/orders/2/receipt'));
  });

  it('puts a finished order back in the cart and opens the cart', async () => {
    const seen = serveApi({
      'GET /api/v1/orders/counts': () => ({ body: counts }),
      'GET /api/v1/orders': () => ({ body: paged([orderListItem({ status: 'completed' })]) }),
      'POST /api/v1/cart/rebuys': () => ({
        status: 201,
        body: {
          added: 1,
          skippedSkuIds: [],
          cart: { items: 1, quantity: 1, availableCount: 1, unavailableCount: 0 },
        },
      }),
      'GET /api/v1/cart/count': () => ({
        body: { items: 1, quantity: 1, availableCount: 1, unavailableCount: 0 },
      }),
    });
    await renderPage(<OrderListPage />);
    fireEvent.click(await screen.findByRole('button', { name: '再次购买' }));
    await waitFor(() => expect(taroFake.calls.some((c) => c.api === 'switchTab')).toBe(true));
    expect(seen.find((r) => r.key === 'POST /api/v1/cart/rebuys')?.body).toEqual({
      orderId: '9001',
    });
  });

  it('asks a signed-out visitor to sign in instead of listing', async () => {
    useSession.setState({ session: { status: 'signed-out' } });
    serveApi({});
    await renderPage(<OrderListPage />);
    expect(document.getElementById('login-card')).toBeTruthy();
  });
});
