import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ResponseOf } from '@shop/api-client';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import GroupbuyListPage from './index';

type Card = ResponseOf<'groupbuy.list'>['items'][number];

const card = (patch: Partial<Card> = {}): Card => ({
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
  ...patch,
});

function serve(items: Card[], banners: Array<{ imageUrl: string; link: string | null }> = []) {
  return serveApi({
    'GET /api/v1/groupbuy/banners': () => ({ body: { items: banners } }),
    'GET /api/v1/groupbuy/summary': () => ({ body: { participants: 12, avatars: ['a.png'] } }),
    'GET /api/v1/groupbuy/activities': () => ({
      body: { items, total: items.length, page: 1, pageSize: 20 },
    }),
  });
}

describe('拼团 list', () => {
  it('lists the activities with the honest rule, and opens one', async () => {
    serve([card(), card({ activityId: '2', title: '三人团', startAt: '2099-01-01T00:00:00Z' })]);
    await renderPage(<GroupbuyListPage />);
    fireEvent.click(await screen.findByRole('link', { name: /双人团 · 护理套装/ }));
    expect(taroFake.calls.at(-1)).toEqual({
      api: 'navigateTo',
      args: { url: '/packages/promo/groupbuy-detail/index?id=1' },
    });
    expect(screen.getByText('2人团')).toBeTruthy();
    expect(screen.getByText('即将开始')).toBeTruthy();
    expect(screen.getByText(/到时间未凑齐，拼团自动取消，已付款项原路退回/)).toBeTruthy();
    expect(screen.getByText('12 人正在拼团')).toBeTruthy();
    expect(document.querySelectorAll('img[src="a.png"]').length).toBe(0);
  });

  it('makes only an in-app banner link tappable', async () => {
    serve(
      [card()],
      [
        { imageUrl: 'b1.png', link: '/pages/activity/goods_combination/index' },
        { imageUrl: 'b2.png', link: '/packages/promo/groupbuy-detail/index?id=1' },
      ],
    );
    await renderPage(<GroupbuyListPage />);
    await screen.findByRole('link', { name: /双人团/ });
    expect(screen.queryByRole('button', { name: '拼团活动 1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '拼团活动 2' }));
    expect(taroFake.calls.at(-1)).toEqual({
      api: 'navigateTo',
      args: { url: '/packages/promo/groupbuy-detail/index?id=1' },
    });
  });

  it('answers the share menu with the list', async () => {
    serve([]);
    await renderPage(<GroupbuyListPage />);
    await screen.findByText('暂时没有拼团活动');
    expect(taroFake.shareHandlers.message?.()).toMatchObject({
      path: '/packages/promo/groupbuy/index',
    });
  });
});
