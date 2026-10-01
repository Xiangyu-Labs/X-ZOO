import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppConfigStore } from '@/app-config';
import { useSession } from '@/session/session';
import { appConfigFixture } from '@/test/app-config-fixture';
import { cardFixture, pageOf } from '@/test/catalog-fixture';
import { orderFixture } from '@/test/checkout-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage, testQueryClient } from '@/test/render';
import { routeQueryKey } from '@shop/api-client/react';
import { taroFake } from '@/test/taro-fake/taro';
import PayResultPage, { POLL_LIMIT_MS } from './index';

type Status = 'submitted' | 'paid' | 'failed';

function serve(status: Status, kind: 'normal' | 'groupbuy' = 'normal') {
  return serveApi({
    'GET /api/v1/payments/P9': () => ({
      body: {
        outTradeNo: 'P9',
        orderId: '9',
        status,
        paid: status === 'paid',
        paidAt: status === 'paid' ? '2026-09-23T10:05:00+08:00' : null,
      },
    }),
    'GET /api/v1/orders/9': () => ({
      body: orderFixture({
        kind,
        status: 'paid',
        paidAmount: '116.00',
        payExpiresAt: null,
        groupbuyTeamId: kind === 'groupbuy' ? '5' : null,
      }),
    }),
    'GET /api/v1/catalog/products': () => ({
      body: pageOf([cardFixture({ id: '31', name: '温感按摩油' })]),
    }),
  });
}

describe('支付结果', () => {
  beforeEach(() => {
    taroFake.routerParams = { orderId: '9', outTradeNo: 'P9' };
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
    useAppConfigStore.setState({ config: appConfigFixture, source: 'network' });
  });
  afterEach(() => vi.useRealTimers());

  it('says the payment went through, links the order and recommends', async () => {
    serve('paid');
    await renderPage(<PayResultPage />);

    expect(await screen.findByText('支付成功')).toBeTruthy();
    expect(await screen.findByText(/实付 ¥116.00/)).toBeTruthy();
    expect(await screen.findByText('温感按摩油')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看订单' }));
    expect(taroFake.calls).toContainEqual({
      api: 'redirectTo',
      args: { url: '/packages/order/detail/index?id=9' },
    });
    fireEvent.click(screen.getByRole('button', { name: '继续购物' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'switchTab',
        args: { url: '/pages/index/index' },
      }),
    );
  });

  it('goes back to 订单详情 when 收银台 was opened from it, not to a second copy', async () => {
    serve('paid');
    taroFake.pageStack = [
      { route: 'packages/order/list/index', options: {} },
      { route: 'packages/order/detail/index', options: { id: '9' } },
      { route: 'packages/order/pay-result/index', options: { orderId: '9', outTradeNo: 'P9' } },
    ];
    await renderPage(<PayResultPage />);
    fireEvent.click(await screen.findByRole('button', { name: '查看订单' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({ api: 'navigateBack', args: { delta: 1 } }),
    );
    expect(taroFake.calls.some((call) => call.api === 'redirectTo')).toBe(false);
  });

  it('drops the order reads cached while the order was unpaid', async () => {
    serve('paid');
    const client = testQueryClient();
    const listKey = routeQueryKey('order.list', { query: {} });
    const teamsKey = routeQueryKey('groupbuy.myGroups', { query: {} });
    client.setQueryData(listKey, { items: [], page: 1, pageSize: 20, total: 0 });
    client.setQueryData(teamsKey, { items: [], page: 1, pageSize: 20, total: 0 });
    const presaleKey = routeQueryKey('presale.detail', { params: { id: '5' } });
    client.setQueryData(presaleKey, {});
    const meKey = routeQueryKey('decor.pageUserCenter');
    client.setQueryData(meKey, {});
    await renderPage(<PayResultPage />, client);

    expect(await screen.findByText('支付成功')).toBeTruthy();
    await waitFor(() => expect(client.getQueryState(listKey)?.isInvalidated).toBe(true));
    // A 拼团 seat is taken once paid.
    expect(client.getQueryState(teamsKey)?.isInvalidated).toBe(true);
    // A 预售 counts the deposit, and 我的's 订单入口 no longer says 待付款.
    expect(client.getQueryState(presaleKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(meKey)?.isInvalidated).toBe(true);
  });

  it('sends a group buyer to invite friends', async () => {
    serve('paid', 'groupbuy');
    await renderPage(<PayResultPage />);
    fireEvent.click(await screen.findByRole('button', { name: '邀请好友参团' }));
    // In place of 支付结果 (Back from the team does not come back here), to this order's team.
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/packages/promo/groupbuy-team/index?id=5' },
      }),
    );
  });

  it('offers 重新支付 after a failed attempt', async () => {
    serve('failed');
    await renderPage(<PayResultPage />);
    expect(await screen.findByText('支付未完成')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新支付' }));
    expect(taroFake.calls).toContainEqual({
      api: 'redirectTo',
      args: { url: '/packages/order/cashier/index?orderId=9' },
    });
  });

  it('keeps asking, then says it is still confirming and offers a refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const seen = serve('submitted');
    await renderPage(<PayResultPage />);
    expect(await screen.findByText('正在确认支付结果，请稍候')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_LIMIT_MS + 1000);
    });
    expect(await screen.findByText(/微信支付的结果还没有到达/)).toBeTruthy();
    const asked = seen.filter((r) => r.key === 'GET /api/v1/payments/P9').length;
    expect(asked).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('正在确认支付结果，请稍候')).toBeTruthy();
  });
});

describe('支付结果 — signing in on the page', () => {
  it('sends the SMS login back to this payment’s result', async () => {
    taroFake.routerParams = { orderId: '9', outTradeNo: 'P9' };
    useSession.setState({ session: { status: 'phone-required', bindToken: 'b' } });
    serve('paid');
    await renderPage(<PayResultPage />);
    fireEvent.click(screen.getByRole('button', { name: '短信验证码登录' }));
    const redirect = '{"route":"payResult","params":{"orderId":"9","outTradeNo":"P9"}}';
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: `/pages/login/index?mode=sms&redirect=${encodeURIComponent(redirect)}` },
      }),
    );
  });
});
