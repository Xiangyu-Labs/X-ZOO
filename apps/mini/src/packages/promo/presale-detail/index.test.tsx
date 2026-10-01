import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ResponseOf } from '@shop/api-client';
import { useCheckoutDraft } from '@/features/checkout/draft';
import { useSession } from '@/session/session';
import { serveApi, type FakeReply } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import PresaleDetailPage from './index';

type Activity = ResponseOf<'presale.detail'>;

const activity = (patch: Partial<Activity> = {}): Activity => ({
  activityId: '2',
  productId: '12',
  title: '新品预售 · 香氛礼盒',
  intro: null,
  imageUrl: null,
  price: '128.00',
  originalPrice: '168.00',
  stock: 50,
  sales: 7,
  startAt: '2020-01-01T00:00:00Z',
  endAt: '2099-01-01T00:00:00Z',
  shipAfterDays: 15,
  canBuy: true,
  sliderImages: [],
  perOrderQuantity: 3,
  description: null,
  skus: [
    {
      skuId: '31',
      specText: '标准装',
      specValues: { 规格: '标准装' },
      imageUrl: null,
      price: '128.00',
      originalPrice: '168.00',
      stock: 50,
    },
  ],
  ...patch,
});

function serve(detail: Activity | { reply: FakeReply }) {
  return serveApi({
    'GET /api/v1/presale/activities/2': () => ('reply' in detail ? detail.reply : { body: detail }),
  });
}

const navigatedTo = () =>
  taroFake.calls
    .filter((call) => call.api === 'navigateTo')
    .map((call) => (call.args as { url: string }).url);

describe('预售商品', () => {
  beforeEach(() => {
    taroFake.routerParams = { id: '2' };
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
    useCheckoutDraft.setState({ draft: null });
  });

  it('says it is full payment and when it ships, and books through checkout', async () => {
    serve(activity());
    await renderPage(<PresaleDetailPage />);
    expect(await screen.findByText('全款预订，付款后 15 天内发货')).toBeTruthy();
    expect(screen.getByText('下单时支付全部货款，无需另付尾款')).toBeTruthy();
    expect(screen.getByText('已售 7 件')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '立即预订' }));
    const confirm = await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: '立即预订' });
      expect(buttons.length).toBe(2);
      return buttons[1]!;
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(navigatedTo().at(-1)).toBe('/packages/order/checkout/index'));
    expect(useCheckoutDraft.getState().draft).toEqual({
      source: 'buy-now',
      item: { skuId: '31', quantity: 1 },
      kind: 'presale',
      kindMeta: { activityId: '2' },
    });
  });

  it('shows an upcoming presale with a countdown to its start and no booking', async () => {
    serve(activity({ startAt: '2098-01-01T00:00:00Z', canBuy: false }));
    await renderPage(<PresaleDetailPage />);
    expect(await screen.findByText('距开始')).toBeTruthy();
    const button = screen.getByRole('button', { name: '即将开始' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  it('asks a visitor to log in before booking', async () => {
    useSession.setState({ session: { status: 'phone-required', bindToken: 'b' } });
    serve(activity());
    await renderPage(<PresaleDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '立即预订' }));
    await waitFor(() => expect(navigatedTo()[0]).toMatch(/^\/pages\/login\/index\?redirect=/));
  });

  it('goes back to the 商品详情 it was opened from for 查看商品, else takes its place', async () => {
    serve(activity());
    taroFake.pageStack = [
      { route: 'pages/product/index', options: { id: '12' } },
      { route: 'packages/promo/presale-detail/index', options: { id: '2' } },
    ];
    await renderPage(<PresaleDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '查看商品' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({ api: 'navigateBack', args: { delta: 1 } }),
    );

    taroFake.pageStack = [
      { route: 'packages/promo/presale/index', options: {} },
      { route: 'packages/promo/presale-detail/index', options: { id: '2' } },
    ];
    fireEvent.click(screen.getByRole('button', { name: '查看商品' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/pages/product/index?id=12' },
      }),
    );
    expect(navigatedTo()).toEqual([]);
  });

  it('says a removed presale is over', async () => {
    serve({
      reply: {
        status: 404,
        body: { code: 'PRESALE_ACTIVITY_NOT_FOUND', message: '预售活动不存在或已下架' },
      },
    });
    await renderPage(<PresaleDetailPage />);
    expect(await screen.findByText('预售活动已结束')).toBeTruthy();
  });

  it('shares to friends and the timeline', async () => {
    serve(activity());
    await renderPage(<PresaleDetailPage />);
    await screen.findByText('新品预售 · 香氛礼盒');
    expect(taroFake.shareHandlers.message?.()).toMatchObject({
      title: '预售 ¥128.00 新品预售 · 香氛礼盒',
      path: '/packages/promo/presale-detail/index?id=2',
    });
    expect(taroFake.shareHandlers.timeline?.()).toMatchObject({ query: 'id=2' });
  });
});
