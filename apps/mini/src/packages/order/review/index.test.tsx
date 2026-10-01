import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { orderDetail, orderItem } from '@/test/order-fixtures';
import { renderPage } from '@/test/render';
import { routeQueryKey } from '@shop/api-client/react';
import { taroFake } from '@/test/taro-fake/taro';
import ReviewPage from './index';

const received = orderDetail({
  status: 'received',
  items: [
    orderItem('7001', { productName: '商品甲', reviewable: true }),
    orderItem('7002', { productName: '商品乙', reviewable: true }),
    orderItem('7003', { productName: '已退商品', refundedQuantity: 1 }),
  ],
});

function answer(moderation: 'published' | 'pending') {
  return {
    status: 201,
    body: {
      id: '1',
      skuId: null,
      specText: null,
      authorNickname: null,
      authorAvatarUrl: null,
      productScore: 5,
      serviceScore: 5,
      content: null,
      images: [],
      replyContent: null,
      replyAt: null,
      createdAt: '2026-02-05T10:00:00+08:00',
      moderation,
    },
  };
}

describe('评价商品', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
    taroFake.routerParams = { orderId: '9001' };
  });

  it('offers every reviewable line, and sends each with its stars and words', async () => {
    const seen = serveApi({
      'GET /api/v1/orders/9001': () => ({ body: received }),
      'POST /api/v1/catalog/reviews': () => answer('published'),
    });
    const { client } = await renderPage(<ReviewPage />);
    const productReviews = routeQueryKey('catalog.productReviews', { params: { id: '12' } });
    client.setQueryData(productReviews, { items: [], page: 1, pageSize: 10, total: 0 });
    const product = routeQueryKey('catalog.productDetail', { params: { id: '12' } });
    client.setQueryData(product, {});
    const me = routeQueryKey('decor.pageUserCenter');
    client.setQueryData(me, {});
    await screen.findByText('商品甲');
    expect(screen.queryByText('已退商品')).toBeNull();

    fireEvent.click(screen.getAllByRole('radio', { name: '商品评分 3 星' })[0]!);
    fireEvent.click(screen.getByRole('radio', { name: '服务评分 4 星' }));
    fireEvent.change(screen.getAllByLabelText('评价内容')[0]!, { target: { value: ' 很好 ' } });
    fireEvent.click(screen.getByRole('button', { name: '提交评价' }));

    await screen.findByText('评价成功');
    const bodies = seen.filter((r) => r.key === 'POST /api/v1/catalog/reviews').map((r) => r.body);
    expect(bodies).toEqual([
      { orderItemId: '7001', productScore: 3, serviceScore: 4, content: '很好', images: [] },
      { orderItemId: '7002', productScore: 5, serviceScore: 4, images: [] },
    ]);
    await waitFor(() => expect(client.getQueryState(productReviews)?.isInvalidated).toBe(true));
    // 商品详情 carries the review summary; 我的's 待评价 badge drops.
    expect(client.getQueryState(product)?.isInvalidated).toBe(true);
    expect(client.getQueryState(me)?.isInvalidated).toBe(true);
  });

  it('says 审核后展示, never an error, when the shop holds a review', async () => {
    serveApi({
      'GET /api/v1/orders/9001': () => ({
        body: { ...received, items: [orderItem('7001', { reviewable: true })] },
      }),
      'POST /api/v1/catalog/reviews': () => answer('pending'),
    });
    await renderPage(<ReviewPage />);
    fireEvent.click(await screen.findByRole('button', { name: '提交评价' }));
    await screen.findByText('评价已提交，审核后展示');
    expect(taroFake.calls.some((c) => c.api === 'showToast')).toBe(false);
  });

  it('counts a line reviewed before as done, and stops at a real failure', async () => {
    let call = 0;
    serveApi({
      'GET /api/v1/orders/9001': () => ({ body: received }),
      'POST /api/v1/catalog/reviews': () => {
        call += 1;
        return call === 1
          ? {
              status: 409,
              body: { code: 'CATALOG_REVIEW_ALREADY_WRITTEN', message: '已经评价过了' },
            }
          : { status: 500, body: { code: 'INTERNAL', message: '服务器开小差了，请稍后再试' } };
      },
    });
    await renderPage(<ReviewPage />);
    fireEvent.click(await screen.findByRole('button', { name: '提交评价' }));

    await screen.findByText('已评价');
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'showToast',
        args: expect.objectContaining({ title: '服务器开小差了，请稍后再试' }),
      }),
    );
    // 商品乙 is still there to try again.
    expect(screen.getAllByLabelText('评价内容')).toHaveLength(1);
  });

  it('shows a line reviewed before as done up front and sends only the others', async () => {
    const seen = serveApi({
      'GET /api/v1/orders/9001': () => ({
        body: {
          ...received,
          items: [
            orderItem('7001', { productName: '商品甲', reviewed: true }),
            orderItem('7002', { productName: '商品乙', reviewable: true }),
          ],
        },
      }),
      'POST /api/v1/catalog/reviews': () => answer('published'),
    });
    await renderPage(<ReviewPage />);
    await screen.findByText('已评价');
    expect(screen.getAllByLabelText('评价内容')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '提交评价' }));
    await screen.findByText('评价成功');
    const bodies = seen.filter((r) => r.key === 'POST /api/v1/catalog/reviews').map((r) => r.body);
    expect(bodies).toEqual([{ orderItemId: '7002', productScore: 5, serviceScore: 5, images: [] }]);
  });

  it('says so when every line was reviewed already', async () => {
    serveApi({
      'GET /api/v1/orders/9001': () => ({
        body: { ...received, items: [orderItem('7001', { reviewed: true })] },
      }),
    });
    taroFake.pageStack = [
      { route: 'packages/order/detail/index', options: { id: '9001' } },
      { route: 'packages/order/review/index', options: { orderId: '9001' } },
    ];
    await renderPage(<ReviewPage />);
    await screen.findByText('已经评价过了');
    expect(screen.queryByRole('button', { name: '提交评价' })).toBeNull();

    // 返回订单 goes back to the 订单详情 underneath rather than stacking a copy of it.
    fireEvent.click(screen.getByRole('button', { name: '返回订单' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({ api: 'navigateBack', args: { delta: 1 } }),
    );
  });

  it('writes only the line it was sent for', async () => {
    taroFake.routerParams = { orderId: '9001', orderItemId: '7002' };
    serveApi({ 'GET /api/v1/orders/9001': () => ({ body: received }) });
    await renderPage(<ReviewPage />);
    await screen.findByText('商品乙');
    expect(screen.queryByText('商品甲')).toBeNull();
  });

  it('explains when the order cannot be reviewed yet', async () => {
    serveApi({ 'GET /api/v1/orders/9001': () => ({ body: orderDetail({ status: 'shipped' }) }) });
    await renderPage(<ReviewPage />);
    await screen.findByText('暂时不能评价');
  });
});
