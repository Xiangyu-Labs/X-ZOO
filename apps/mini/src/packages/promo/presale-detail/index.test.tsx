import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ResponseOf } from '@shop/api-client';
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
  descriptionBlocks: [],
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

describe('预售商品 (old shared links)', () => {
  beforeEach(() => {
    taroFake.routerParams = { id: '2' };
    useSession.setState({ session: { status: 'idle' } });
  });

  it('takes the place of itself with the product page, where 预售 now lives', async () => {
    serve(activity());
    await renderPage(<PresaleDetailPage />);
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/pages/product/index?id=12' },
      }),
    );
    expect(taroFake.calls.filter((call) => call.api === 'navigateTo')).toEqual([]);
  });

  it('says a removed presale is over and offers the other 预售', async () => {
    serve({
      reply: {
        status: 404,
        body: { code: 'PRESALE_ACTIVITY_NOT_FOUND', message: '预售活动不存在或已下架' },
      },
    });
    await renderPage(<PresaleDetailPage />);
    expect(await screen.findByText('预售活动已结束')).toBeTruthy();
    expect(screen.getByRole('button', { name: '看看其他预售' })).toBeTruthy();
    expect(taroFake.calls.filter((call) => call.api === 'redirectTo')).toEqual([]);
  });
});
