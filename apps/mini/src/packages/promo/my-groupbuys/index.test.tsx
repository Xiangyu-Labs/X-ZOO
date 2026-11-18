import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { routeQueryKey } from '@shop/api-client/react';
import type { MyTeam } from '@/features/groupbuy/team';
import { useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import MyGroupbuysPage from './index';

const team = (patch: Partial<MyTeam>): MyTeam => ({
  groupId: '501',
  activityId: '1',
  title: '双人团 · 护理套装',
  imageUrl: null,
  status: 'forming',
  role: 'leader',
  memberStatus: 'joined',
  orderId: '70',
  orderDeletable: false,
  seatsTotal: 2,
  seatsTaken: 1,
  expiresAt: '2099-01-01T00:00:00Z',
  createdAt: '2026-09-24T00:00:00Z',
  ...patch,
});

function serve(items: MyTeam[]) {
  return serveApi({
    'GET /api/v1/groupbuy/my-groups': () => ({
      body: { items, total: items.length, page: 1, pageSize: 20 },
    }),
  });
}

describe('我的拼团', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
  });

  it('lists every team with its state, and opens a team', async () => {
    serve([
      team({}),
      team({ groupId: '502', status: 'failed', memberStatus: 'refunded', orderId: '71' }),
    ]);
    await renderPage(<MyGroupbuysPage />);
    await screen.findByText('拼团中 · 还差 1 人');
    expect(screen.getByText('未成团，已退款')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /双人团 · 护理套装，未成团，已退款/ }));
    expect(taroFake.calls.at(-1)).toEqual({
      api: 'navigateTo',
      args: { url: '/packages/promo/groupbuy-team/index?id=502' },
    });
  });

  it('asks again when it comes back, as a team fills while the shopper is away', async () => {
    const seen = serve([team({})]);
    await renderPage(<MyGroupbuysPage />);
    await screen.findByText('拼团中 · 还差 1 人');
    taroFake.showPage();
    await waitFor(() => expect(seen).toHaveLength(2));
  });

  it('filters by tab', async () => {
    const seen = serve([team({})]);
    await renderPage(<MyGroupbuysPage />);
    await screen.findByText('拼团中 · 还差 1 人');
    expect(seen[0]?.query.status).toBeUndefined();
    fireEvent.click(screen.getByRole('tab', { name: '未成团' }));
    await waitFor(() => expect(seen.at(-1)?.query).toMatchObject({ status: 'failed' }));
  });

  it('opens an order still in progress, which cannot be deleted', async () => {
    serve([team({ status: 'succeeded' })]);
    await renderPage(<MyGroupbuysPage />);
    fireEvent.click(await screen.findByRole('button', { name: '查看订单' }));
    expect(screen.queryByRole('button', { name: '删除订单' })).toBeNull();
    expect(taroFake.calls.at(-1)).toEqual({
      api: 'navigateTo',
      args: { url: '/packages/order/detail/index?id=70' },
    });
  });

  const finished = team({ status: 'failed', memberStatus: 'refunded', orderDeletable: true });

  it('deletes a finished order after asking, and drops it from the list', async () => {
    let items = [finished];
    const seen = serveApi({
      'GET /api/v1/groupbuy/my-groups': () => ({
        body: { items, total: items.length, page: 1, pageSize: 20 },
      }),
      'DELETE /api/v1/orders/70': () => {
        items = [];
        return { body: { hidden: true } };
      },
    });
    const { client } = await renderPage(<MyGroupbuysPage />);
    const orders = routeQueryKey('order.list', { query: {} });
    client.setQueryData(orders, { items: [], page: 1, pageSize: 20, total: 0 });

    fireEvent.click(await screen.findByRole('button', { name: '删除订单' }));
    expect(await screen.findByText('还没有参加过拼团')).toBeTruthy();
    expect(seen.map((r) => r.key)).toContain('DELETE /api/v1/orders/70');
    expect(screen.queryByRole('button', { name: '查看订单' })).toBeNull();
    expect(taroFake.calls.find((call) => call.api === 'showModal')?.args).toMatchObject({
      content: '删除后，这笔订单不再显示在我的拼团和我的订单中，确定删除吗？',
    });
    expect(taroFake.calls.find((call) => call.api === 'showToast')?.args).toMatchObject({
      title: '订单已删除',
    });
    expect(client.getQueryState(orders)?.isInvalidated).toBe(true);
  });

  it('deletes nothing when the shopper backs out', async () => {
    taroFake.modalConfirm = false;
    const seen = serve([finished]);
    await renderPage(<MyGroupbuysPage />);
    fireEvent.click(await screen.findByRole('button', { name: '删除订单' }));
    await waitFor(() => expect(taroFake.calls.some((c) => c.api === 'showModal')).toBe(true));
    expect(seen.map((r) => r.key)).not.toContain('DELETE /api/v1/orders/70');
  });

  it('says why when the server refuses, and refreshes the card', async () => {
    const seen = serveApi({
      'GET /api/v1/groupbuy/my-groups': () => ({
        body: { items: [finished], total: 1, page: 1, pageSize: 20 },
      }),
      'DELETE /api/v1/orders/70': () => ({
        status: 409,
        body: {
          code: 'ORDER_NOT_DELETABLE',
          message: '订单还有售后在处理，处理完后才能删除',
          details: { openRefund: true },
        },
      }),
    });
    await renderPage(<MyGroupbuysPage />);
    fireEvent.click(await screen.findByRole('button', { name: '删除订单' }));
    await waitFor(() =>
      expect(taroFake.calls.find((call) => call.api === 'showToast')?.args).toMatchObject({
        title: '订单还有售后在处理，处理完后才能删除',
      }),
    );
    await waitFor(() =>
      expect(seen.filter((r) => r.key === 'GET /api/v1/groupbuy/my-groups').length).toBe(2),
    );
  });
});
