import { orders } from '@shop/db/schema/order';
import { users } from '@shop/db/schema/user';
import { eq } from 'drizzle-orm';

import { test, expect } from '../src/mini';
import { currentQuery } from '../src/mini-pages/order-pages';
import {
  CartPage,
  CashierPage,
  CheckoutPage,
  HomePage,
  ProductPage,
  SearchPage,
} from '../src/mini-pages/shopping-pages';
import {
  arrangeCartLine,
  cartQuantities,
  returningShopper,
  signedInToken,
} from '../src/mini-pages/shopping-shopper';
import { shown } from '../src/mini-pages/shown';

/**
 * The shopping pages one motion at a time (the whole journey is `shop-journey.spec.ts`):
 * 搜索, 规格, 优惠券 at 确认订单, the cart's quantity, and a guest who browses freely and meets
 * the login page only at 加入购物车.
 *
 * Prices: the multi-spec product is ¥59 (M) / ¥65 (L), free shipping; the postage product is
 * ¥39 plus ¥6 freight to the seeded 深圳 address; the seeded coupon takes ¥5 off, no minimum.
 */

test('search from 首页 finds a product by keyword', async ({ miniPage: page, shop }) => {
  void shop;
  const home = new HomePage(page);
  await home.open();
  await home.openSearch();
  await expect(page).toHaveURL(/packages\/goods\/search\/index/);

  const search = new SearchPage(page);
  await search.search('运费');
  await expect(page).toHaveURL(/packages\/goods\/list\/index\?keyword=/);
  expect(currentQuery(page).get('keyword')).toBe('运费');
  await expect(search.result(/^E2E 运费商品/)).toBeVisible();
  await expect(search.result(/^E2E 多规格商品/)).toHaveCount(0);

  await search.result(/^E2E 运费商品/).click();
  await expect(new ProductPage(page).name()).toHaveText('E2E 运费商品');
});

test('the 规格 sheet prices the picked SKU and adds that one to the cart', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  const product = new ProductPage(page);
  await product.open(shop.fixtures.multiSpecProductId);
  // The price range ¥59–¥65: the top of the page shows where it starts, the sheet reaches both ends.
  await expect(product.summaryPrice()).toContainText('59');
  await expect(product.summaryPrice()).not.toContainText('65');

  await product.openSpecs();
  await product.specValue('黑').click();
  await product.specValue('M').click();
  await expect(product.sheetPrice()).toContainText('59');
  await product.specValue('L').click();
  await expect(product.specValue('L')).toHaveAttribute('aria-checked', 'true');
  await expect(product.specValue('M')).toHaveAttribute('aria-checked', 'false');
  await expect(product.sheetPrice()).toContainText('65');
  await product.sheetButton('加入购物车').click();
  await expect(shown(page).getByText('已加入购物车')).toBeVisible();

  const blackL = String(shop.fixtures.multiSpecSkuIds[3]);
  expect(Object.fromEntries(await cartQuantities(shopper.api))).toEqual({ [blackL]: 1 });
  // 已选 remembers the pick.
  await expect(shown(page).getByRole('link', { name: /^选择规格/ })).toContainText('黑');
  await shopper.api.dispose();
});

test('确认订单 applies the best coupon, lets the shopper drop it and pick it again', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright, { coupon: true });
  const product = new ProductPage(page);
  await product.open(shop.fixtures.postageProductId);
  await product.barButton('立即购买').click();
  await expect(product.sheet()).toBeVisible();
  await product.sheetButton('立即购买').click();

  // The one usable coupon is applied without asking: 39 + 6 − 5.
  const checkout = new CheckoutPage(page);
  await checkout.expectShown();
  await expect(checkout.couponCell()).toContainText('-¥5.00');
  await expect(checkout.bar()).toContainText('40.00');

  // 不使用优惠券 → full price.
  await checkout.couponCell().click();
  await expect(checkout.couponSheet()).toBeVisible();
  await shown(page).getByRole('radio', { name: '不使用优惠券' }).click();
  await expect(checkout.couponCell()).toContainText('不使用');
  await expect(checkout.bar()).toContainText('45.00');

  // Picked again from the sheet.
  await checkout.couponCell().click();
  await shown(page)
    .getByRole('radio', { name: /^E2E 满减券/ })
    .click();
  await expect(checkout.bar()).toContainText('40.00');
  await checkout.submit();

  const cashier = new CashierPage(page);
  await cashier.expectShown();
  await expect(cashier.amount()).toContainText('40.00');
  const orderId = Number(currentQuery(page).get('orderId'));
  const [order] = await shop.db
    .select({ payableAmount: orders.payableAmount, couponDiscount: orders.couponDiscount })
    .from(orders)
    .where(eq(orders.id, orderId));
  expect(order).toEqual({ payableAmount: '40.00', couponDiscount: '5.00' });
  await shopper.api.dispose();
});

test('+ in the cart changes the quantity on the server and the total', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  await arrangeCartLine(shopper.api, shop.fixtures.postageSkuId);
  const cart = new CartPage(page);
  await cart.open();

  await expect(cart.row('E2E 运费商品')).toBeVisible();
  await expect(cart.bar()).toContainText('39.00');
  await cart.increase('E2E 运费商品').click();

  await expect(async () => {
    const quantities = await cartQuantities(shopper.api);
    expect(quantities.get(String(shop.fixtures.postageSkuId))).toBe(2);
  }).toPass({ timeout: 10_000 });
  await expect(cart.bar()).toContainText('78.00');
  await expect(cart.bar()).toContainText('结算(2)');
  await shopper.api.dispose();
});

test('a guest browses freely and signs up only at 加入购物车, then comes back to it', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
}) => {
  // A WeChat user the shop has never seen: browsing asks for nothing.
  const home = new HomePage(page);
  await home.open();
  await home.openProduct('E2E 多规格商品');
  const product = new ProductPage(page);
  await expect(product.name()).toHaveText('E2E 多规格商品');
  await expect(shown(page).getByText('手机号快速登录')).toHaveCount(0);

  // 加入购物车 needs an account: the login page, which comes back here.
  await product.barButton('加入购物车').click();
  await expect(page).toHaveURL(/pages\/login\/index\?redirect=/);
  await shown(page).getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }).click();
  await shown(page).getByText('手机号快速登录', { exact: true }).click();
  await expect(page).toHaveURL(/pages\/product\/index\?id=/);
  await expect(product.name()).toHaveText('E2E 多规格商品');

  const [user] = await shop.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.phone, wechatUser.phone));
  expect(user, 'the phone step made the account').toBeDefined();

  await product.barButton('加入购物车').click();
  await product.specValue('白').click();
  await product.specValue('M').click();
  await product.sheetButton('加入购物车').click();
  await expect(shown(page).getByText('已加入购物车')).toBeVisible();

  const api = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: {
      Authorization: `Bearer ${await signedInToken(page)}`,
      'X-Client-Platform': 'wechat-mini',
    },
  });
  const whiteM = String(shop.fixtures.multiSpecSkuIds[0]);
  expect(Object.fromEntries(await cartQuantities(api))).toEqual({ [whiteM]: 1 });
  await api.dispose();
});
