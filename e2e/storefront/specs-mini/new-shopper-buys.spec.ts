import { userSessions } from '@shop/db/schema/auth';
import { paymentAttempts } from '@shop/db/schema/payment';
import { users } from '@shop/db/schema/user';
import { wechatIdentities } from '@shop/db/schema/wechat';
import { eq } from 'drizzle-orm';

import {
  SHENZHEN_WECHAT_ADDRESS,
  miniRoute,
  newWechatUser,
  sessionToken,
  test as base,
  expect,
} from '../src/mini';
import {
  CashierPage,
  CheckoutPage,
  PayResultPage,
  ProductPage,
} from '../src/mini-pages/shopping-pages';
import { shown } from '../src/mini-pages/shown';

// This shopper's WeChat hands over a 深圳 address at 导入微信地址.
const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  wechatUser: async ({}, use) => {
    await use(newWechatUser({ address: SHENZHEN_WECHAT_ADDRESS }));
  },
});

/**
 * The mini-program's first journey, end to end: a WeChat user who has never
 * opened the shop lands on a product from a shared link and browses it as a
 * guest. 立即购买 needs an account: the login page, where the shopper shares
 * their phone number to finish signing up, then back to the product, the
 * 规格 sheet, 确认订单 with an address imported from WeChat, and payment.
 *
 * Every step is the real server. Only what WeChat itself does on a phone is
 * the harness's: the `wx.login` and `getPhoneNumber` codes (redeemed by the
 * server against the fake `api.weixin.qq.com`), `wx.chooseAddress`, and the
 * shopper confirming the payment sheet (the fake WeChat Pay gateway settles
 * the transaction the server placed and posts the signed notification to the
 * real webhook).
 *
 * The postage product costs ¥39 plus ¥6 freight to the seeded 深圳 division,
 * so one unit is ¥45.00; a checkout that dropped the freight shows ¥39.00.
 */
test('a new WeChat user signs in, binds a phone, buys a product and pays', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const productId = shop.fixtures.postageProductId;

  // A shared product link opens the app straight on 商品详情; a guest can look.
  await page.goto(miniRoute('pages/product/index', { id: productId }));
  const product = new ProductPage(page);
  await expect(product.name()).toHaveText('E2E 运费商品');

  // The silent wx.login found no account for this openid: 立即购买 opens the login page.
  await product.barButton('立即购买').click();
  await expect(page).toHaveURL(/pages\/login\/index\?redirect=/);
  await shown(page).getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }).click();
  await shown(page).getByText('手机号快速登录', { exact: true }).click();

  // Signed up: back on the product, which the login page replaced itself with.
  await expect(page).toHaveURL(/pages\/product\/index\?id=/);
  await expect(product.name()).toHaveText('E2E 运费商品');

  // The account exists now, made by the phone step, from the mini-program.
  const [user] = await shop.db
    .select({ id: users.id, registerSource: users.registerSource })
    .from(users)
    .where(eq(users.phone, wechatUser.phone));
  expect(user, `no user with phone ${wechatUser.phone}`).toBeDefined();
  expect(user!.registerSource).toBe('wechat_mini');
  const identities = await shop.db
    .select({ openid: wechatIdentities.openid, platform: wechatIdentities.platform })
    .from(wechatIdentities)
    .where(eq(wechatIdentities.userId, user!.id));
  expect(identities).toEqual([{ openid: wechatUser.openid, platform: 'mini' }]);
  const sessions = await shop.db
    .select({ platform: userSessions.platform })
    .from(userSessions)
    .where(eq(userSessions.userId, user!.id));
  expect(sessions.map((session) => session.platform)).toEqual(['wechat-mini']);

  // 立即购买 → the 规格 sheet → 确认订单.
  await product.barButton('立即购买').click();
  await expect(product.sheet()).toBeVisible();
  await product.sheetButton('立即购买').click();
  const checkout = new CheckoutPage(page);
  await checkout.expectShown();

  // No address yet: 导入微信地址 saves WeChat's, and freight is priced to it.
  await checkout.importWechatAddress();
  await expect(checkout.address()).toContainText('小程序新客');
  await expect(checkout.bar()).toContainText('45.00');
  await checkout.submit();

  // 收银台 replaces 确认订单, so 返回 cannot resubmit.
  const cashier = new CashierPage(page);
  await cashier.expectShown();
  const orderId = new URL(page.url().replace('/#/', '/')).searchParams.get('orderId')!;
  await expect(cashier.amount()).toContainText('45.00');
  await cashier.pay();

  // requestPayment "succeeded"; the page believes the server, not the sheet.
  await new PayResultPage(page).expectPaid();

  // The order is paid, as the shopper's own API sees it.
  const api = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: {
      Authorization: `Bearer ${await sessionToken(page)}`,
      'X-Client-Platform': 'wechat-mini',
    },
  });
  const response = await api.get(`/api/v1/orders/${orderId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const order = (await response.json()) as {
    status: string;
    payableAmount: string;
    paidAmount: string | null;
  };
  expect(order).toMatchObject({ status: 'paid', payableAmount: '45.00', paidAmount: '45.00' });
  await api.dispose();

  // Charged as a mini-program payment, to the mini-program's app id.
  const attempts = await shop.db
    .select({ channel: paymentAttempts.channel, appId: paymentAttempts.appId })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, Number(orderId)));
  expect(attempts).toEqual([{ channel: 'wechat_mini', appId: shop.wechatMiniAppId }]);

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
