import { shipOrder } from '@shop/core/order';
import { productFavorites } from '@shop/db/schema/catalog';
import { notificationMessages } from '@shop/db/schema/notification';
import { userCancellationRequests, userInvoiceProfiles, users } from '@shop/db/schema/user';
import type { Page } from '@playwright/test';
import { and, eq, isNull } from 'drizzle-orm';

import { holdPhone, miniRoute, sessionToken, test, expect } from '../src/mini';
import { dialogButton, OrderDetailPage } from '../src/mini-pages/order-pages';
import {
  arrangeMiniPaidOrder,
  signUpFromOrders,
  TRACKING_NO,
} from '../src/mini-pages/order-shopper';
import { openFresh, shown } from '../src/mini-pages/shown';
import { CashierPage, CheckoutPage, ProductPage } from '../src/mini-pages/shopping-pages';
import { arrangePaidOrder } from '../src/product-flows';

/**
 * The mini-program's account pages, end to end (stream E): 个人资料, 收货地址 and its select
 * mode at 确认订单, 我的收藏, 消息, 发票抬头, 我的评价 and 注销账号.
 *
 * Each test signs a new WeChat shopper up the way C's order specs do (`signUpFromOrders`, which
 * also gives the account a default 深圳 address). A received order to review is arranged through
 * the API; the order pages that lead there are C's.
 */

const PROFILE = 'packages/account/profile/index';
const ADDRESSES = 'packages/account/addresses/index';
const FAVORITES = 'packages/account/favorites/index';
const MESSAGES = 'packages/account/messages/index';
const INVOICES = 'packages/account/invoices/index';
const MY_REVIEWS = 'packages/account/reviews/index';
const SETTINGS = 'packages/account/settings/index';

/** An input of the page on top, by its placeholder. */
function input(page: Page, placeholder: string) {
  return shown(page).locator(`input[placeholder="${placeholder}"]`);
}

test('a nickname the content check rejects is a field error, and a fine one saves', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);

  await openFresh(page, miniRoute(PROFILE));
  const nickname = input(page, '填写昵称');
  await nickname.fill('违规测试小号');
  await shown(page).getByText('保存', { exact: true }).click();
  await expect(shown(page).getByText('昵称包含不当信息，请修改后再保存')).toBeVisible();

  // Typing again clears the error; a fine nickname saves.
  await nickname.fill('夜猫子');
  await expect(shown(page).getByText('昵称包含不当信息，请修改后再保存')).toHaveCount(0);
  await shown(page).getByText('保存', { exact: true }).click();
  await expect(shown(page).getByText('已保存')).toBeVisible();

  const [row] = await shop.db
    .select({ nickname: users.nickname })
    .from(users)
    .where(eq(users.id, shopper.userId));
  expect(row?.nickname).toBe('夜猫子');

  // The rejected save is the one 422, and the page handled it.
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual(['PUT /api/v1/profile 422']);
});

test('a shopper adds, edits, picks at checkout and deletes an address', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);

  // 新增: the region from the sheet, one level at a time.
  await openFresh(page, miniRoute(ADDRESSES));
  await expect(shown(page).getByText('小程序买家', { exact: true })).toBeVisible();
  await shown(page).getByText('新增收货地址', { exact: true }).click();
  await input(page, '姓名').fill('张三');
  await input(page, '收货人手机号').fill('13800138000');
  await shown(page).getByText('请选择省 / 市 / 区', { exact: true }).click();
  await shown(page).getByRole('radio', { name: '广东省', exact: true }).click();
  await shown(page).getByRole('radio', { name: '深圳市', exact: true }).click();
  await shown(page).getByRole('radio', { name: '南山区', exact: true }).click();
  await expect(shown(page).getByText('广东省 深圳市 南山区', { exact: true })).toBeVisible();
  await input(page, '街道、楼牌号等').fill('科技园路 8 号');
  await shown(page).getByText('保存', { exact: true }).click();

  const row = shown(page).getByRole('button', { name: /^张三，.*，编辑$/ });
  await expect(row).toContainText('科技园路 8 号');

  // 编辑.
  await shown(page).getByRole('button', { name: '编辑 张三 的地址' }).click();
  await expect(input(page, '街道、楼牌号等')).toHaveValue('科技园路 8 号');
  await input(page, '街道、楼牌号等').fill('科技园路 9 号');
  await shown(page).getByText('保存', { exact: true }).click();
  await expect(row).toContainText('科技园路 9 号');

  // 确认订单 starts from the default address; its address sheet lists the book.
  const product = new ProductPage(page);
  await product.open(shop.fixtures.postageProductId);
  await product.barButton('立即购买').click();
  await product.sheetButton('立即购买').click();
  const checkout = new CheckoutPage(page);
  await checkout.expectShown();
  await expect(checkout.address()).toContainText('小程序买家');
  await checkout.address().click();
  await shown(page)
    .locator('#address-sheet')
    .getByRole('radio', { name: /^张三，/ })
    .click();
  await expect(checkout.address()).toContainText('张三');
  await expect(checkout.address()).toContainText('科技园路 9 号');

  await checkout.submit();
  await new CashierPage(page).expectShown();
  const orderId = new URL(page.url().replace('/#/', '/')).searchParams.get('orderId');
  const order = await shopper.api.get(`/api/v1/orders/${orderId}`);
  expect(JSON.stringify(await order.json())).toContain('科技园路 9 号');

  // 删除.
  await openFresh(page, miniRoute(ADDRESSES));
  await shown(page).getByRole('button', { name: '删除 张三 的地址' }).click();
  await dialogButton(page, '删除').click();
  await expect(shown(page).getByText('已删除')).toBeVisible();
  await expect(shown(page).getByText('张三', { exact: true })).toHaveCount(0);
  await expect(shown(page).getByText('小程序买家', { exact: true })).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('a favourited product is in 我的收藏, and leaves it', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);

  // 收藏 on the product page's bar.
  const product = new ProductPage(page);
  await product.open(shop.fixtures.postageProductId);
  await shown(page).locator('.shop-action-bar').getByRole('button', { name: '收藏' }).click();
  await expect(
    shown(page).locator('.shop-action-bar').getByRole('button', { name: '已收藏' }),
  ).toBeVisible();

  await openFresh(page, miniRoute(FAVORITES));
  await expect(shown(page).getByText('共 1 件')).toBeVisible();
  await shown(page).getByText('E2E 运费商品').first().click();
  await expect(page).toHaveURL(/pages\/product\/index\?id=\d+/);
  await expect(product.name()).toHaveText('E2E 运费商品');

  // 管理 → tick → 取消收藏.
  await openFresh(page, miniRoute(FAVORITES));
  await shown(page).getByText('管理', { exact: true }).click();
  await shown(page).getByRole('checkbox', { name: '选择 E2E 运费商品' }).click();
  await shown(page).getByText('取消收藏（1）', { exact: true }).click();
  await dialogButton(page, '取消收藏').click();
  await expect(shown(page).getByText('还没有收藏')).toBeVisible();

  const left = await shop.db
    .select({ id: productFavorites.productId })
    .from(productFavorites)
    .where(eq(productFavorites.userId, shopper.userId));
  expect(left).toEqual([]);

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('a message opens the page it is about, and is read after', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);
  const order = await arrangeMiniPaidOrder(page, shopper, shop);

  // The worker writes 支付成功 into the inbox after the payment commits.
  await expect(async () => {
    const rows = await shop.db
      .select({ id: notificationMessages.id })
      .from(notificationMessages)
      .where(eq(notificationMessages.userId, shopper.userId));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 20_000 });

  // 我的 says there is something unread, and leads to 消息.
  await openFresh(page, miniRoute('pages/me/index'));
  await shown(page)
    .getByRole('link', { name: /^\d+ 条未读消息$/ })
    .click();
  await expect(page).toHaveURL(new RegExp(MESSAGES));

  await shown(page).getByRole('link', { name: '未读，支付成功' }).click();
  const detail = new OrderDetailPage(page);
  await expect(page).toHaveURL(new RegExp(`packages/order/detail/index\\?id=${order.id}`));
  await detail.expectHeadline('等待发货');

  // Back in 消息 it is read.
  await openFresh(page, miniRoute(MESSAGES));
  await expect(shown(page).getByRole('link', { name: '支付成功', exact: true })).toBeVisible();
  const [paid] = await shop.db
    .select({ readAt: notificationMessages.readAt })
    .from(notificationMessages)
    .where(
      and(
        eq(notificationMessages.userId, shopper.userId),
        eq(notificationMessages.title, '支付成功'),
      ),
    );
  expect(paid?.readAt).not.toBeNull();

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('a shopper saves an invoice title imported from WeChat', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  await holdPhone(page, {
    ...wechatUser,
    invoiceTitle: {
      type: '0',
      title: '深圳某某贸易有限公司',
      taxNumber: '91440300MA5YYYYY1B',
      companyAddress: '',
      telephone: '',
      bankName: '',
      bankAccount: '',
    },
  });
  const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);

  await openFresh(page, miniRoute(INVOICES));
  await expect(shown(page).getByText('还没有发票抬头')).toBeVisible();
  await shown(page).getByText('新增发票抬头', { exact: true }).click();
  await shown(page).getByRole('link', { name: '从微信导入' }).click();
  await expect(input(page, '单位全称')).toHaveValue('深圳某某贸易有限公司');
  await expect(input(page, '纳税人识别号')).toHaveValue('91440300MA5YYYYY1B');
  await input(page, '接收电子发票').fill('finance@example.com');
  await shown(page).getByText('保存', { exact: true }).click();

  await expect(
    shown(page).getByRole('button', { name: '深圳某某贸易有限公司，编辑' }),
  ).toBeVisible();

  const saved = await shop.db
    .select({
      headerType: userInvoiceProfiles.headerType,
      name: userInvoiceProfiles.name,
      dutyNumber: userInvoiceProfiles.dutyNumber,
      email: userInvoiceProfiles.email,
    })
    .from(userInvoiceProfiles)
    .where(
      and(eq(userInvoiceProfiles.userId, shopper.userId), isNull(userInvoiceProfiles.deletedAt)),
    );
  expect(saved).toEqual([
    {
      headerType: 'company',
      name: '深圳某某贸易有限公司',
      dutyNumber: '91440300MA5YYYYY1B',
      email: 'finance@example.com',
    },
  ]);

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('我的评价 shows a review the content check held, as waiting', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);
  // A received order and its review, arranged: the order pages are stream C's. Paid on the H5
  // channel so 确认收货 needs no WeChat component.
  const api = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${await sessionToken(page)}` },
  });
  const order = await arrangePaidOrder(api, shop, {
    skuId: shop.fixtures.postageSkuId,
    addressId: Number(shopper.addressId),
  });
  await shipOrder(shop.ctx, {
    orderId: Number(order.id),
    body: {
      deliveryMode: 'express',
      lines: [],
      expressCompanyId: String(shop.fixtures.expressCompanyId),
      trackingNo: TRACKING_NO,
    },
    operatorAdminId: shop.admin.id,
  });
  const receipt = await api.post(`/api/v1/orders/${order.id}/receipt`, { data: {} });
  expect(receipt.ok(), await receipt.text()).toBe(true);
  const detail = (await (await api.get(`/api/v1/orders/${order.id}`)).json()) as {
    items: Array<{ id: string }>;
  };
  const review = await api.post('/api/v1/catalog/reviews', {
    data: {
      orderItemId: detail.items[0]!.id,
      productScore: 4,
      serviceScore: 5,
      content: '包装很严实，待定测试',
    },
  });
  expect(review.ok(), await review.text()).toBe(true);
  await api.dispose();

  await openFresh(page, miniRoute(MY_REVIEWS));
  await expect(shown(page).getByText('包装很严实，待定测试')).toBeVisible();
  await expect(shown(page).getByText('审核后展示', { exact: true })).toBeVisible();
  await expect(shown(page).getByRole('img', { name: '4 星' })).toBeVisible();
  await shown(page).getByRole('link', { name: 'E2E 运费商品' }).click();
  await expect(page).toHaveURL(
    new RegExp(`pages/product/index\\?id=${shop.fixtures.postageProductId}`),
  );

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('注销账号 files the request and signs the shopper out', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);
  const token = await sessionToken(page);

  await openFresh(page, miniRoute(SETTINGS));
  await shown(page).getByRole('link', { name: '注销账号' }).click();
  await expect(
    shown(page).getByText('审核通过后，昵称、头像、手机号等账号信息会被清除', { exact: false }),
  ).toBeVisible();

  // Not without agreeing to the 注销协议.
  await shown(page).getByText('申请注销', { exact: true }).click();
  await expect(shown(page).getByText('请先阅读并同意《注销协议》')).toBeVisible();

  await shown(page).locator('textarea').fill('不再使用');
  await shown(page).getByRole('checkbox', { name: '我已阅读并同意《注销协议》' }).click();
  await shown(page).getByText('申请注销', { exact: true }).click();
  await dialogButton(page, '确认注销').click();
  await expect(shown(page).getByText('已提交注销申请')).toBeVisible();

  // Signed out here and on the server.
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('shop.session.token')))
    .toBeNull();
  const stale = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, 'X-Client-Platform': 'wechat-mini' },
  });
  expect((await stale.get('/api/v1/profile')).status()).toBe(401);
  await stale.dispose();

  const [request] = await shop.db
    .select({ status: userCancellationRequests.status, reason: userCancellationRequests.reason })
    .from(userCancellationRequests)
    .where(eq(userCancellationRequests.userId, shopper.userId));
  expect(request).toEqual({ status: 'pending', reason: '不再使用' });

  // 我的 is a guest's again.
  await shown(page).getByText('回到首页', { exact: true }).click();
  await openFresh(page, miniRoute('pages/me/index'));
  await expect(shown(page).getByText('登录 / 注册', { exact: true })).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
