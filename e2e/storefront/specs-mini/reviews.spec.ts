import type { APIRequestContext, Page } from '@playwright/test';
import { productReviews } from '@shop/db/schema/catalog';
import { eq } from 'drizzle-orm';

import { miniRoute, test, expect } from '../src/mini';
import type { Stack } from '../src/stack';
import { ReviewPage } from '../src/mini-pages/order-pages';
import {
  arrangeMiniPaidOrder,
  expectOrderStatus,
  shipByExpress,
  type MiniShopper,
} from '../src/mini-pages/order-shopper';
import { returningShopper } from '../src/mini-pages/shopping-shopper';
import { openFresh, shown } from '../src/mini-pages/shown';

/**
 * Reviews and their moderation, from the shopper's 评价 to what every shopper reads on
 * 商品评价 (`packages/goods/reviews/index`). The content check is the fake WeChat's
 * `msgSecCheck`: it holds text with 待定测试 for a person, and passes plain text. The merchant's
 * side is 评价管理's route (`POST /admin-api/catalog/reviews/:id/status`).
 *
 * Arranged, not driven: a paid, shipped, received order of the postage product (the order
 * pages are `orders.spec.ts`'s, 确认收货 in WeChat included). Every review's words carry this
 * run's stamp, because other journeys review the same product.
 */

/** A received order of the postage product, ready for 去评价. */
async function receivedOrder(
  page: Page,
  shopper: MiniShopper,
  shop: Stack,
  adminApi: APIRequestContext,
): Promise<string> {
  const order = await arrangeMiniPaidOrder(page, shopper, shop);
  await shipByExpress(adminApi, shop, order.id);
  const received = await shopper.api.post(`/api/v1/orders/${order.id}/receipt`, { data: {} });
  expect(received.ok(), await received.text()).toBe(true);
  await expectOrderStatus(shopper, order.id, ['received', 'completed']);
  return order.id;
}

/** Writes `words` for the order's line on 评价, and answers the stored review. */
async function review(page: Page, shop: Stack, orderId: string, words: string) {
  await openFresh(page, miniRoute('packages/order/review/index', { orderId }));
  const form = new ReviewPage(page);
  await form.expectOpen();
  await form.write(words);
  await form.submit();
  await expect(form.result()).toBeVisible();
  const [row] = await shop.db
    .select({ id: productReviews.id, status: productReviews.status })
    .from(productReviews)
    .where(eq(productReviews.orderId, Number(orderId)));
  expect(row, `no review stored for order ${orderId}`).toBeDefined();
  return { id: String(row!.id), status: row!.status, result: form.result() };
}

/** 商品评价 of the postage product, opened fresh. */
async function openProductReviews(page: Page, shop: Stack): Promise<void> {
  await openFresh(
    page,
    miniRoute('packages/goods/reviews/index', { productId: shop.fixtures.postageProductId }),
  );
  await expect(shown(page).getByText('综合评分', { exact: true })).toBeVisible();
  // The list has loaded: reviews, or 还没有人评价 — not the skeleton.
  await expect(
    shown(page).locator('.shop-review').or(shown(page).getByText('还没有人评价')).first(),
  ).toBeVisible();
}

async function moderate(
  adminApi: APIRequestContext,
  reviewId: string,
  status: 'published' | 'hidden',
): Promise<void> {
  const response = await adminApi.post(`/admin-api/catalog/reviews/${reviewId}/status`, {
    data: { status },
  });
  expect(response.status(), await response.text()).toBe(200);
}

test('CONTENT-001: a review the content check holds is shown on the product only once the merchant publishes it', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  adminApi,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  const orderId = await receivedOrder(page, shopper, shop, adminApi);
  const words = `做工不错 ${Date.now()}，待定测试`;

  const written = await review(page, shop, orderId, words);
  expect(written.status).toBe('pending');
  await expect(written.result).toContainText('评价已提交，审核后展示');

  // Held: nobody reads it on the product, its author included.
  await openProductReviews(page, shop);
  await expect(shown(page).getByText(words)).toHaveCount(0);

  // 评价管理 → 通过: every shopper reads it now.
  await moderate(adminApi, written.id, 'published');
  await openProductReviews(page, shop);
  await expect(shown(page).getByText(words)).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  await shopper.api.dispose();
});

test('a review the content check passes is on the product at once, and gone once the merchant hides it', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  adminApi,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  const orderId = await receivedOrder(page, shopper, shop, adminApi);
  const words = `物流很快，包装严实 ${Date.now()}`;

  const written = await review(page, shop, orderId, words);
  expect(written.status).toBe('published');
  await expect(written.result).toContainText('评价成功');

  await openProductReviews(page, shop);
  await expect(shown(page).getByText(words)).toBeVisible();

  // 评价管理 → 隐藏.
  await moderate(adminApi, written.id, 'hidden');
  await openProductReviews(page, shop);
  await expect(shown(page).getByText(words)).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  await shopper.api.dispose();
});
