import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ResponseOf } from '@shop/api-client';
import { useCheckoutDraft } from '@/features/checkout/draft';
import { useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import GroupbuyDetailPage from './index';

type Activity = ResponseOf<'groupbuy.detail'>;
type OpenTeam = ResponseOf<'groupbuy.openGroups'>['items'][number];

const sku = (id: string, stock = 5) => ({
  skuId: id,
  specText: `款式${id}`,
  specValues: { 款式: `款式${id}` },
  imageUrl: null,
  price: '59.00',
  originalPrice: '88.00',
  stock,
});

const activity = (patch: Partial<Activity> = {}): Activity => ({
  activityId: '1',
  productId: '11',
  title: '双人团 · 护理套装',
  intro: null,
  imageUrl: null,
  price: '59.00',
  originalPrice: '88.00',
  seatsRequired: 2,
  stock: 20,
  sales: 3,
  startAt: '2020-01-01T00:00:00Z',
  endAt: '2099-01-01T00:00:00Z',
  formingGroups: 1,
  canBuy: true,
  sliderImages: [],
  groupTtlSeconds: 86400,
  perOrderQuantity: 2,
  description: null,
  skus: [sku('21'), sku('22', 0)],
  myOpenGroupId: null,
  myOpenGroupRole: null,
  ...patch,
});

const openTeam: OpenTeam = {
  groupId: '501',
  leaderNickname: '小*',
  leaderAvatarUrl: 'leader.png',
  seatsTotal: 2,
  seatsTaken: 1,
  seatsLeft: 1,
  expiresAt: '2099-01-01T00:00:00Z',
};

function serve(detail: Activity | { status: number; body: unknown }, teams: OpenTeam[] = []) {
  return serveApi({
    'GET /api/v1/groupbuy/activities/1': () => ('status' in detail ? detail : { body: detail }),
    'GET /api/v1/groupbuy/activities/1/groups': () => ({
      body: { items: teams, total: teams.length, page: 1, pageSize: 5 },
    }),
  });
}

const navigatedTo = () =>
  taroFake.calls
    .filter((call) => call.api === 'navigateTo')
    .map((call) => (call.args as { url: string }).url);

describe('拼团商品', () => {
  beforeEach(() => {
    taroFake.routerParams = { id: '1' };
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
    useCheckoutDraft.setState({ draft: null });
  });

  it('shows the price, the honest rule and the open teams without names or faces', async () => {
    serve(activity(), [openTeam]);
    await renderPage(<GroupbuyDetailPage />);
    await screen.findByText('双人团 · 护理套装');
    expect(screen.getByText('2人团')).toBeTruthy();
    expect(screen.getByText('2 人成团，开团后 1 天内有效')).toBeTruthy();
    expect(screen.getByText('到时间未凑齐，拼团自动取消，已付款项原路退回')).toBeTruthy();
    expect(await screen.findByText('还差 1 人成团')).toBeTruthy();
    expect(screen.queryByText(/小明/)).toBeNull();
    expect(document.querySelectorAll('img[src="leader.png"]').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '去参团，还差 1 人' }));
    expect(navigatedTo().at(-1)).toBe('/packages/promo/groupbuy-team/index?id=501');
  });

  it('shows the team the shopper just opened when they come back from paying', async () => {
    let mine: string | null = null;
    serveApi({
      'GET /api/v1/groupbuy/activities/1': () => ({ body: activity({ myOpenGroupId: mine }) }),
      'GET /api/v1/groupbuy/activities/1/groups': () => ({
        body: { items: [], total: 0, page: 1, pageSize: 5 },
      }),
    });
    const { client } = await renderPage(<GroupbuyDetailPage />);
    expect(await screen.findByRole('button', { name: '发起拼团' })).toBeTruthy();
    expect(screen.queryByText('你发起的团正在拼')).toBeNull();
    // 确认订单 → 收银台 → 支付结果 mark it stale; the page is shown again.
    mine = '777';
    taroFake.hidePage();
    await client.invalidateQueries({ queryKey: ['groupbuy.detail'], refetchType: 'none' });
    taroFake.showPage();
    expect(await screen.findByText('你发起的团正在拼')).toBeTruthy();
  });

  it('opens a team: picks a SKU and hands checkout a group-buy draft', async () => {
    serve(activity());
    await renderPage(<GroupbuyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '发起拼团' }));
    const soldOut = await screen.findByRole('radio', { name: '款式22，已售罄' });
    expect(soldOut.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '款式21' }));
    fireEvent.click(screen.getByRole('button', { name: '增加购买数量' }));
    const confirm = screen.getAllByRole('button', { name: '发起拼团' }).at(-1);
    fireEvent.click(confirm!);
    await waitFor(() => expect(navigatedTo().at(-1)).toBe('/packages/order/checkout/index'));
    expect(useCheckoutDraft.getState().draft).toEqual({
      source: 'buy-now',
      item: { skuId: '21', quantity: 2 },
      kind: 'groupbuy',
      kindMeta: { activityId: '1' },
    });
  });

  it('sends a leader with an open team to it', async () => {
    serve(activity({ myOpenGroupId: '777' }));
    await renderPage(<GroupbuyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '查看我的团' }));
    expect(navigatedTo().at(-1)).toBe('/packages/promo/groupbuy-team/index?id=777');
  });

  it('AGENTS 16 — reads the activity again once signed in: a leader is sent to their team', async () => {
    useSession.setState({ session: { status: 'idle' } });
    // The server says which team is the shopper's only to a signed-in shopper.
    serveApi({
      'GET /api/v1/groupbuy/activities/1': () => ({
        body: activity({
          myOpenGroupId: useSession.getState().session.status === 'signed-in' ? '777' : null,
          myOpenGroupRole: useSession.getState().session.status === 'signed-in' ? 'leader' : null,
        }),
      }),
      'GET /api/v1/groupbuy/activities/1/groups': () => ({
        body: { items: [], total: 0, page: 1, pageSize: 5 },
      }),
    });
    await renderPage(<GroupbuyDetailPage />);
    expect(await screen.findByRole('button', { name: '发起拼团' })).toBeTruthy();

    // The silent login lands while the shared activity is open.
    act(() => useSession.setState({ session: { status: 'signed-in', token: 't' } }));
    expect(await screen.findByRole('button', { name: '查看我的团' })).toBeTruthy();
  });

  it('tells a member the open team is one they joined, not one they started', async () => {
    serve(activity({ myOpenGroupId: '777', myOpenGroupRole: 'member' }));
    await renderPage(<GroupbuyDetailPage />);
    await screen.findByText('你参加的团正在拼');
    expect(screen.queryByText('你发起的团正在拼')).toBeNull();
    fireEvent.click(screen.getByText('你参加的团正在拼'));
    expect(navigatedTo().at(-1)).toBe('/packages/promo/groupbuy-team/index?id=777');
  });

  it('asks a visitor to log in before opening a team', async () => {
    useSession.setState({ session: { status: 'phone-required', bindToken: 'b' } });
    serve(activity());
    await renderPage(<GroupbuyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '发起拼团' }));
    await waitFor(() => expect(navigatedTo()[0]).toMatch(/^\/pages\/login\/index\?redirect=/));
    expect(screen.queryByRole('radio', { name: '款式21' })).toBeNull();
  });

  it('says when the activity has ended, and 单独购买 still opens the product', async () => {
    serve(activity({ endAt: '2021-01-01T00:00:00Z', canBuy: false }));
    await renderPage(<GroupbuyDetailPage />);
    const ended = await screen.findAllByText('活动已结束');
    expect(ended.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '单独购买' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/pages/product/index?id=11' },
      }),
    );
  });

  it('goes back to the 商品详情 it was opened from for 单独购买, not to a second copy', async () => {
    serve(activity());
    taroFake.pageStack = [
      { route: 'pages/product/index', options: { id: '11' } },
      { route: 'packages/promo/groupbuy-detail/index', options: { id: '1' } },
    ];
    await renderPage(<GroupbuyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '单独购买' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({ api: 'navigateBack', args: { delta: 1 } }),
    );
    expect(navigatedTo()).toEqual([]);
  });

  it('says a removed activity is over', async () => {
    serve({
      status: 404,
      body: { code: 'GROUPBUY_ACTIVITY_NOT_FOUND', message: '拼团活动不存在或已下架' },
    });
    await renderPage(<GroupbuyDetailPage />);
    expect(await screen.findByText('拼团活动已结束')).toBeTruthy();
  });

  it('shares to friends and the timeline', async () => {
    serve(activity());
    await renderPage(<GroupbuyDetailPage />);
    await screen.findByText('双人团 · 护理套装');
    expect(taroFake.shareHandlers.message?.()).toMatchObject({
      title: '2人团 ¥59.00 双人团 · 护理套装',
      path: '/packages/promo/groupbuy-detail/index?id=1',
    });
    expect(taroFake.shareHandlers.timeline?.()).toMatchObject({ query: 'id=1' });
  });
});
