import { test, expect } from '../src/mini';
import { expectOrderStatus } from '../src/mini-pages/order-shopper';
import {
  CartPage,
  CashierPage,
  CategoryPage,
  CheckoutPage,
  HomePage,
  openTab,
  PayResultPage,
  ProductPage,
} from '../src/mini-pages/shopping-pages';
import { cartQuantities, returningShopper } from '../src/mini-pages/shopping-shopper';
import { shown } from '../src/mini-pages/shown';
import { currentQuery } from '../src/mini-pages/order-pages';

/**
 * The shopping journey of the mini-program, end to end, as a shopper the shop already knows:
 * 首页 (the 页面装修 v2 page) → the 分类 tab → 商品详情 → 规格 → 购物车 → 结算 → 确认订单 →
 * 收银台 → 微信支付 (the fake gateway settles it) → 支付结果.
 *
 * The multi-spec product ships free, so 白 / L pays its own price, ¥65.00.
 */
test('a shopper goes from 首页 through 分类 and the cart to a paid order', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  const home = new HomePage(page);
  await home.open();

  // The 分类 tab, on the seeded category.
  await openTab(page, '分类');
  await expect(page).toHaveURL(/pages\/category\/index/);
  const category = new CategoryPage(page);
  await expect(category.tab('E2E 类目')).toHaveAttribute('aria-selected', 'true');
  await category.product('E2E 多规格商品').click();

  // 商品详情 → 加入购物车 → 白 / L.
  const product = new ProductPage(page);
  await expect(product.name()).toHaveText('E2E 多规格商品');
  await product.barButton('加入购物车').click();
  await expect(product.sheet()).toBeVisible();
  await product.specValue('白').click();
  await product.specValue('L').click();
  await product.sheetButton('加入购物车').click();
  await expect(shown(page).getByText('已加入购物车')).toBeVisible();
  const whiteL = String(shop.fixtures.multiSpecSkuIds[1]);
  expect((await cartQuantities(shopper.api)).get(whiteL)).toBe(1);

  // The bar's 购物车 icon → the cart tab.
  await product.cartIcon().click();
  await expect(page).toHaveURL(/pages\/cart\/index/);
  const cart = new CartPage(page);
  await expect(cart.row('E2E 多规格商品')).toContainText('白 / L');
  await expect(cart.bar()).toContainText('65.00');
  await cart.checkout();

  // 确认订单: the default address, the line, no coupon to apply.
  const checkout = new CheckoutPage(page);
  await checkout.expectShown();
  await expect(checkout.address()).toContainText('老顾客');
  await expect(shown(page).locator('#checkout-lines')).toContainText('白 / L');
  await expect(checkout.bar()).toContainText('65.00');
  await checkout.submit();

  // 收银台 replaces 确认订单; 微信支付; 支付结果 asks the server.
  const cashier = new CashierPage(page);
  await cashier.expectShown();
  const orderId = currentQuery(page).get('orderId')!;
  await expect(cashier.amount()).toContainText('65.00');
  await cashier.pay();
  await new PayResultPage(page).expectPaid();
  await expectOrderStatus(shopper, orderId, ['paid']);

  // The cart line was bought.
  expect((await cartQuantities(shopper.api)).has(whiteL)).toBe(false);
  // 查看订单 opens the paid order.
  await shown(page).getByText('查看订单', { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`packages/order/detail/index\\?id=${orderId}`));

  await shopper.api.dispose();
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
