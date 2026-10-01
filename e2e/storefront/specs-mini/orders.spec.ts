import { productReviews } from '@shop/db/schema/catalog';
import { eq } from 'drizzle-orm';

import { miniRoute, newWechatUser, test, expect } from '../src/mini';
import { openFresh, shown } from '../src/mini-pages/shown';
import {
  dialogButton,
  LogisticsPage,
  OrderDetailPage,
  OrderListPage,
  ReviewPage,
} from '../src/mini-pages/order-pages';
import {
  expectOrderStatus,
  payAtMiniCashier,
  placeOrder,
  shipByExpress,
  signUpFromOrders,
  TRACKING_NO,
  waitForWechatReceipt,
} from '../src/mini-pages/order-shopper';

/**
 * The mini-program's order pages, end to end (stream C): a WeChat shopper pays
 * an order from 我的订单, sees it wait for shipping, follows the parcel the
 * merchant sent, confirms receipt in WeChat's own 确认收货 component and
 * reviews it; and a shopper cancels an order they have not paid.
 *
 * Arranged, not driven: the account's address and the unpaid order (the
 * buying pages are `new-shopper-buys.spec.ts`'s), and the shipment (the admin
 * console's). WeChat's side is the harness's: the payment sheet, and the
 * 确认收货 component, which marks the payment confirmed on the fake
 * `api.weixin.qq.com` — the server still asks WeChat before it believes it.
 */

test('a shopper pays, follows the parcel, confirms receipt in WeChat and reviews', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  adminApi,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);
  const order = await placeOrder(shopper, shop);
  const list = new OrderListPage(page);
  const detail = new OrderDetailPage(page);

  // 待付款 → 立即付款 on the card → 收银台.
  await list.open('unpaid');
  const unpaid = list.card(order.orderNo);
  await expect(unpaid).toContainText('¥45.00');
  await unpaid.getByText('立即付款', { exact: true }).click();
  await payAtMiniCashier(page);
  await expectOrderStatus(shopper, order.id, ['paid']);

  // Paid: filed under 待发货, and the order says so.
  await list.open('unshipped');
  await expect(list.card(order.orderNo)).toBeVisible();
  await detail.open(order.id);
  await detail.expectHeadline('等待发货');
  await expect(shown(page).getByText('商家正在准备商品，将以保密包装发出')).toBeVisible();

  // The merchant ships by 顺丰; the worker reports it to WeChat.
  await shipByExpress(adminApi, shop, order.id);
  await waitForWechatReceipt(shopper, order.id);

  await detail.open(order.id);
  await detail.expectHeadline('已发货');
  await detail.parcel().click();
  await new LogisticsPage(page).expectParcel('顺丰速运', TRACKING_NO);
  await detail.open(order.id);
  await detail.expectHeadline('已发货');

  // 确认收货 opens WeChat's component (the harness confirms it), and the app
  // tells the server it was confirmed there.
  const receipt = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === `/api/v1/orders/${order.id}/receipt` &&
      request.method() === 'POST',
  );
  await detail.action('确认收货').click();
  expect((await receipt).postDataJSON()).toEqual({ via: 'wechat-component' });
  await detail.expectHeadline('已收货');
  await expectOrderStatus(shopper, order.id, ['received', 'completed']);

  // 去评价. Words the content check holds for a person put the review on hold.
  await detail.action('去评价').click();
  const review = new ReviewPage(page);
  await review.expectOpen();
  await expect(shown(page).getByText('评价不显示你的昵称和头像')).toBeVisible();
  await review.write('包装很严实，待定测试');
  await review.submit();
  await expect(review.result()).toContainText('评价已提交，审核后展示');

  const [written] = await shop.db
    .select({ content: productReviews.content, status: productReviews.status })
    .from(productReviews)
    .where(eq(productReviews.orderId, Number(order.id)));
  expect(written).toEqual({ content: '包装很严实，待定测试', status: 'pending' });

  await shown(page).getByText('返回订单', { exact: true }).click();
  await detail.expectHeadline('已收货');

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('a shopper cancels an order they have not paid', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);
  const order = await placeOrder(shopper, shop);
  const detail = new OrderDetailPage(page);

  await detail.open(order.id);
  await detail.expectHeadline('等待付款');
  await detail.action('取消订单').click();
  await expect(shown(page).getByText('确定取消这个订单吗？取消后需重新下单。')).toBeVisible();
  await dialogButton(page, '取消订单').click();

  await detail.expectHeadline('已取消');
  await expectOrderStatus(shopper, order.id, ['cancelled']);
  await expect(detail.action('立即付款')).toHaveCount(0);

  // And 我的订单 files it under 已取消.
  const list = new OrderListPage(page);
  await openFresh(page, miniRoute('packages/order/list/index', { tab: 'cancelled' }));
  await expect(list.card(order.orderNo)).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test.describe("when WeChat's 确认收货 component never calls back", () => {
  test.use({
    // eslint-disable-next-line no-empty-pattern
    wechatUser: async ({}, use) => {
      await use(newWechatUser({ receipt: 'confirm-silently' }));
    },
  });

  test('the app, back in the foreground, asks the server and shows the order received', async ({
    miniPage: page,
    wechatUser,
    shop,
    playwright,
    adminApi,
    consoleErrors,
    failedRequests,
  }) => {
    const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);
    const order = await placeOrder(shopper, shop);
    const detail = new OrderDetailPage(page);
    await new OrderListPage(page).open('unpaid');
    await new OrderListPage(page)
      .card(order.orderNo)
      .getByText('立即付款', { exact: true })
      .click();
    await payAtMiniCashier(page);
    await expectOrderStatus(shopper, order.id, ['paid']);
    await shipByExpress(adminApi, shop, order.id);
    await waitForWechatReceipt(shopper, order.id);

    await detail.open(order.id);
    await detail.expectHeadline('已发货');
    const receipt = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === `/api/v1/orders/${order.id}/receipt` &&
        request.method() === 'POST',
    );
    await detail.action('确认收货').click();
    // No callback: the onShow fallback asks the server, which asks WeChat (C07).
    expect((await receipt).postDataJSON()).toEqual({ via: 'wechat-component' });
    await detail.expectHeadline('已收货');
    await expectOrderStatus(shopper, order.id, ['received', 'completed']);

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});
