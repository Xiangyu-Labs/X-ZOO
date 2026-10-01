import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { page, signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import MyReviewsPage from './index';

const review = {
  id: '51',
  skuId: '1001',
  specText: '白色',
  authorNickname: '小明',
  authorAvatarUrl: null,
  productScore: 4,
  serviceScore: 5,
  content: '包装很严实。',
  images: ['https://cdn.example.com/r/1.png'],
  replyContent: '谢谢支持',
  replyAt: '2026-09-21T10:00:00+08:00',
  createdAt: '2026-09-20T10:00:00+08:00',
  productId: '11',
  productName: '纯棉毛巾',
  productImageUrl: '/uploads/p/11.jpg',
  status: 'published' as const,
};

describe('我的评价', () => {
  it('shows a review with its reply, and one waiting for review or hidden neutrally', async () => {
    signIn();
    serveApi({
      'GET /api/v1/me/reviews': () => ({
        body: page([
          review,
          { ...review, id: '52', content: '还不错', status: 'pending' },
          { ...review, id: '53', content: '一般般', status: 'hidden' },
        ]),
      }),
    });
    await renderPage(<MyReviewsPage />);

    expect(await screen.findByText('包装很严实。')).toBeTruthy();
    expect(screen.getAllByText('谢谢支持')).toHaveLength(3);
    expect(screen.getAllByRole('img', { name: '4 星' })).toHaveLength(3);
    expect(screen.getAllByText('审核后展示')).toHaveLength(1);
    // One the shop took down stays in the author's own list, said plainly.
    expect(screen.getAllByText('仅自己可见')).toHaveLength(1);

    fireEvent.click(screen.getAllByRole('button', { name: '查看第 1 张图片' })[0]!);
    expect(taroFake.calls).toContainEqual({
      api: 'previewImage',
      args: {
        urls: ['https://cdn.example.com/r/1.png'],
        current: 'https://cdn.example.com/r/1.png',
      },
    });

    fireEvent.click(screen.getAllByRole('link', { name: '纯棉毛巾' })[0]!);
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/pages/product/index?id=11' },
      }),
    );
  });
});
