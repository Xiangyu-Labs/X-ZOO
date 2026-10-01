import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
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

  it('opens the order', async () => {
    serve([team({ status: 'succeeded' })]);
    await renderPage(<MyGroupbuysPage />);
    fireEvent.click(await screen.findByRole('button', { name: '查看订单' }));
    expect(taroFake.calls.at(-1)).toEqual({
      api: 'navigateTo',
      args: { url: '/packages/order/detail/index?id=70' },
    });
  });
});
