import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ResponseOf } from '@shop/api-client';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import FlashSaleListPage from './index';

type Card = ResponseOf<'catalog.flashSaleList'>['items'][number];

const card = (patch: Partial<Card> = {}): Card => ({
  activityId: '5',
  productId: '12',
  title: '纯棉短袖T恤',
  imageUrl: null,
  price: '39.90',
  originalPrice: '69.00',
  stock: 50,
  startAt: '2020-01-01T00:00:00Z',
  endAt: '2099-01-01T15:59:00Z',
  canBuy: true,
  ...patch,
});

function serve(items: Card[]) {
  return serveApi({
    'GET /api/v1/catalog/flash-sales': () => ({
      body: { items, total: items.length, page: 1, pageSize: 20 },
    }),
  });
}

describe('限时秒杀 list', () => {
  it('lists the products on 秒杀 with when it ends, and opens the product page of one', async () => {
    serve([card()]);
    await renderPage(<FlashSaleListPage />);
    fireEvent.click(await screen.findByRole('link', { name: /纯棉短袖T恤/ }));
    expect(taroFake.calls.at(-1)).toEqual({
      api: 'navigateTo',
      args: { url: '/pages/product/index?id=12' },
    });
    // Asia/Shanghai, not UTC.
    expect(screen.getByText('2099.01.01 23:59 结束')).toBeTruthy();
  });

  it('answers the share menu with the list', async () => {
    serve([]);
    await renderPage(<FlashSaleListPage />);
    await screen.findByText('暂时没有秒杀活动');
    expect(taroFake.shareHandlers.message?.()).toMatchObject({
      path: '/packages/promo/flash-sale/index',
    });
  });
});
