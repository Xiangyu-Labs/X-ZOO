import type { Page } from '@playwright/test';

import { miniRoute, test, expect } from '../src/mini';
import { placeOrder } from '../src/mini-pages/order-shopper';
import { openTab } from '../src/mini-pages/shopping-pages';
import { returningShopper } from '../src/mini-pages/shopping-shopper';
import { openFresh, shown } from '../src/mini-pages/shown';

/**
 * 我的 (tab `me`) on a shop that never designated a 个人中心 page: `src/seed.ts` designates only
 * the home page, so `GET /api/v1/pages/user-center` answers the built-in document (DECOR-005),
 * drawn by the decor renderer: 用户卡片, 订单入口 (我的订单) and 服务宫格 (我的服务). Each block
 * is found by the `data-block` its frame renders.
 */

const USER_CENTER = '/api/v1/pages/user-center';

function block(page: Page, type: 'userCard' | 'orderEntry' | 'serviceGrid') {
  return shown(page).locator(`[data-block="${type}"]`);
}

/** Opens 我的 from the tab bar and waits for the 个人中心 read. */
async function openMe(page: Page): Promise<void> {
  const answered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === USER_CENTER,
  );
  await openTab(page, '我的');
  expect((await answered).status()).toBe(200);
}

test('the 个人中心 read answers the built-in page, not a 404', async ({ playwright, shop }) => {
  const api = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: { 'X-Client-Platform': 'wechat-mini' },
  });
  const response = await api.get(USER_CENTER);
  expect(response.status(), await response.text()).toBe(200);
  const page = (await response.json()) as {
    id: unknown;
    kind: string;
    personal: unknown;
    blocks: { type: string }[];
  };
  // No designation: the built-in document, and nobody's numbers without a session.
  expect(page).toMatchObject({ id: null, kind: 'user_center', personal: null });
  expect(page.blocks.map((b) => b.type)).toEqual(['userCard', 'orderEntry', 'serviceGrid']);
  await api.dispose();
});

test('我的 shows the member header, the order row and 我的服务', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  // One order waiting for payment: 待付款 carries its count.
  await placeOrder(shopper, shop);

  await openMe(page);

  // The member header: this shopper's name and the three counters.
  const header = block(page, 'userCard');
  await expect(header).toContainText('老顾客');
  for (const counter of ['优惠券', '收藏', '足迹']) {
    await expect(header.getByText(counter, { exact: true })).toBeVisible();
  }
  await expect(header).not.toContainText('登录 / 注册');

  const orders = block(page, 'orderEntry');
  await expect(orders).toContainText('我的订单');
  await expect(orders.getByText('全部订单', { exact: true })).toBeVisible();
  for (const label of ['待付款', '待发货', '待收货', '待评价', '售后/退款']) {
    await expect(orders.getByText(label, { exact: true })).toBeVisible();
  }
  const unpaid = orders.locator('[class*="__entry___"]').filter({ hasText: '待付款' });
  await expect(unpaid).toContainText('1');

  const services = block(page, 'serviceGrid');
  await expect(services).toContainText('我的服务');
  for (const entry of ['优惠券', '领券中心', '收货地址', '我的收藏', '浏览记录']) {
    await expect(services.getByText(entry, { exact: true })).toBeVisible();
  }

  // Entries work: 待付款 opens that tab of 我的订单, 收货地址 the address book.
  await unpaid.click();
  await expect(page).toHaveURL(/packages\/order\/list\/index\?tab=unpaid/);
  await expect(shown(page).getByText('E2E 运费商品').first()).toBeVisible();

  await openFresh(page, miniRoute('pages/me/index'));
  await block(page, 'serviceGrid').getByText('收货地址', { exact: true }).click();
  await expect(page).toHaveURL(/packages\/account\/addresses\/index/);
  await expect(shown(page).getByText('科技园路 7 号', { exact: false })).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  await shopper.api.dispose();
});

test('a visitor who has not logged in sees the header ask them to', async ({
  miniPage: page,
  consoleErrors,
  failedRequests,
}) => {
  // A WeChat user the shop does not know: the silent sign-in stops at phone-required.
  await openFresh(page, miniRoute('pages/index/index'));
  await openMe(page);

  const header = block(page, 'userCard');
  await expect(header).toContainText('登录 / 注册');
  await expect(header).toContainText('登录后查看订单和优惠券');
  // The rest of the page is there, without anyone's numbers.
  await expect(block(page, 'orderEntry').getByText('待付款', { exact: true })).toBeVisible();
  await expect(block(page, 'serviceGrid')).toContainText('我的服务');

  // The header is the way in: the login page, coming back to 我的.
  await header.getByText('登录 / 注册', { exact: true }).click();
  await expect(page).toHaveURL(/pages\/login\/index\?redirect=/);
  await expect(shown(page).getByRole('button', { name: '手机号快速登录' })).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
