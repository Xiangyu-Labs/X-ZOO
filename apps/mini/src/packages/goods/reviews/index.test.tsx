import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { productDetailFixture, reviewFixture } from '@/test/catalog-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import ProductReviews from './index';

describe('商品评价', () => {
  it('shows the score, a tab per rating with counts, and previews pictures', async () => {
    taroFake.routerParams = { productId: '12' };
    const seen = serveApi({
      'GET /api/v1/catalog/products/12/review-summary': () => ({
        body: productDetailFixture().reviewSummary,
      }),
      'GET /api/v1/catalog/products/12/reviews': () => ({
        body: { items: [reviewFixture()], total: 1, page: 1, pageSize: 20 },
      }),
    });

    await renderPage(<ProductReviews />);

    expect(await screen.findByText('包装很严实，质感不错。')).toBeTruthy();
    expect(screen.getByText('4.5')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText('规格：黑 / M')).toBeTruthy();
    expect(screen.getByRole('img', { name: '5 星' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查看第 1 张图片' }));
    expect(taroFake.calls.find((call) => call.api === 'previewImage')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /有图/ }));
    await waitFor(() =>
      expect(
        seen.filter((r) => r.key === 'GET /api/v1/catalog/products/12/reviews').at(-1)?.query,
      ).toMatchObject({ rating: 'images' }),
    );
  });

  it('says so when nobody has reviewed yet', async () => {
    taroFake.routerParams = { productId: '12' };
    serveApi({
      'GET /api/v1/catalog/products/12/review-summary': () => ({
        body: { ...productDetailFixture().reviewSummary, total: 0, goodCount: 0 },
      }),
      'GET /api/v1/catalog/products/12/reviews': () => ({
        body: { items: [], total: 0, page: 1, pageSize: 20 },
      }),
    });
    await renderPage(<ProductReviews />);
    expect(await screen.findByText('还没有人评价')).toBeTruthy();
  });
});
