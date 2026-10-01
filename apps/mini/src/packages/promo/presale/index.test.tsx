import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ResponseOf } from '@shop/api-client';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import PresaleListPage from './index';

type Card = ResponseOf<'presale.list'>['items'][number];

const card = (patch: Partial<Card> = {}): Card => ({
  activityId: '2',
  productId: '12',
  title: '新品预售 · 香氛礼盒',
  intro: null,
  imageUrl: null,
  price: '128.00',
  originalPrice: '168.00',
  stock: 50,
  sales: 0,
  startAt: '2020-01-01T00:00:00Z',
  endAt: '2099-01-01T00:00:00Z',
  shipAfterDays: 15,
  canBuy: true,
  ...patch,
});

function serve(items: Card[]) {
  return serveApi({
    'GET /api/v1/presale/activities': () => ({
      body: { items, total: items.length, page: 1, pageSize: 20 },
    }),
  });
}

describe('预售 list', () => {
  it('lists the activities with when they ship, and opens one', async () => {
    serve([card()]);
    await renderPage(<PresaleListPage />);
    fireEvent.click(await screen.findByRole('link', { name: /新品预售 · 香氛礼盒/ }));
    expect(taroFake.calls.at(-1)).toEqual({
      api: 'navigateTo',
      args: { url: '/packages/promo/presale-detail/index?id=2' },
    });
    expect(screen.getByText('付款后 15 天内发货')).toBeTruthy();
    expect(screen.getByText('全款预订，按约定时间发货')).toBeTruthy();
    expect(screen.queryByText(/定金|尾款/)).toBeNull();
  });

  it('answers the share menu with the list', async () => {
    serve([]);
    await renderPage(<PresaleListPage />);
    await screen.findByText('暂时没有预售活动');
    expect(taroFake.shareHandlers.message?.()).toMatchObject({
      path: '/packages/promo/presale/index',
    });
  });
});
