import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ResponseOf } from '@shop/api-client';
import { useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import GroupbuyDetailPage from './index';

type Activity = ResponseOf<'groupbuy.detail'>;

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
  descriptionBlocks: [],
  skus: [sku('21'), sku('22', 0)],
  myOpenGroupId: null,
  myOpenGroupRole: null,
  ...patch,
});

function serve(detail: Activity | { status: number; body: unknown }) {
  return serveApi({
    'GET /api/v1/groupbuy/activities/1': () => ('status' in detail ? detail : { body: detail }),
  });
}

describe('拼团商品 (old shared links)', () => {
  beforeEach(() => {
    taroFake.routerParams = { id: '1' };
    useSession.setState({ session: { status: 'idle' } });
  });

  it('takes the place of itself with the product page, where 拼团 now lives', async () => {
    serve(activity());
    await renderPage(<GroupbuyDetailPage />);
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/pages/product/index?id=11' },
      }),
    );
    expect(taroFake.calls.filter((call) => call.api === 'navigateTo')).toEqual([]);
  });

  it('says a removed activity is over and offers the other 拼团', async () => {
    serve({
      status: 404,
      body: { code: 'GROUPBUY_ACTIVITY_NOT_FOUND', message: '拼团活动不存在或已下架' },
    });
    await renderPage(<GroupbuyDetailPage />);
    expect(await screen.findByText('拼团活动已结束')).toBeTruthy();
    expect(screen.getByRole('button', { name: '看看其他拼团' })).toBeTruthy();
    expect(taroFake.calls.filter((call) => call.api === 'redirectTo')).toEqual([]);
  });
});
