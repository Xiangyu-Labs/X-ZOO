import type { APIRequestContext, Page, PlaywrightWorkerArgs } from '@playwright/test';
import { addressCreate } from '@shop/core/user';
import { users } from '@shop/db/schema/user';
import { eq } from 'drizzle-orm';

import { expect } from '../fixtures';
import { miniRoute, sessionToken, type EmulatedWechatUser } from '../mini';
import { userActor } from '../seed';
import { CashierPage, PayResultPage } from './shopping-pages';
import { openFresh, shown } from './shown';
import type { Stack } from '../stack';

/**
 * What the order and after-sales journeys arrange rather than drive: a signed-in
 * WeChat shopper with an address, an unpaid order placed through the real
 * checkout API, the merchant's shipment. The buying pages are journey 1's; these
 * specs start where the order exists.
 */

export const TRACKING_NO = 'SF5566778899';

export interface MiniShopper {
  userId: number;
  addressId: string;
  /** The shopper's own API, with the token the app stored and the app's platform header. */
  api: APIRequestContext;
}

/**
 * Opens 我的订单 as a WeChat user the shop has never seen and signs up with the
 * phone number WeChat shares (the `LoginCard`'s 手机号快速登录). Then gives the
 * new account a default address in the seeded 深圳 division.
 */
export async function signUpFromOrders(
  page: Page,
  wechatUser: EmulatedWechatUser,
  shop: Stack,
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<MiniShopper> {
  await openFresh(page, miniRoute('packages/order/list/index'));
  await shown(page).getByText('手机号快速登录', { exact: true }).click();
  await expect(shown(page).getByText('还没有订单', { exact: false })).toBeVisible();

  const [user] = await shop.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.phone, wechatUser.phone));
  expect(user, `no user with phone ${wechatUser.phone}`).toBeDefined();
  const address = await addressCreate(shop.ctx.as(userActor(user!.id)), {
    receiverName: '小程序买家',
    receiverPhone: wechatUser.phone,
    ...shop.fixtures.division,
    provinceName: '广东省',
    cityName: '深圳市',
    districtName: '南山区',
    detail: '科技园路 5 号',
    isDefault: true,
  });
  const api = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: {
      Authorization: `Bearer ${await sessionToken(page)}`,
      'X-Client-Platform': 'wechat-mini',
    },
  });
  return { userId: user!.id, addressId: String(address.id), api };
}

/** An unpaid order for one unit of the postage product (¥39 + ¥6 freight), placed through the API. */
export async function placeOrder(
  shopper: MiniShopper,
  shop: Stack,
): Promise<{ id: string; orderNo: string }> {
  const created = await shopper.api.post('/api/v1/orders', {
    data: {
      source: 'buy-now',
      item: { skuId: String(shop.fixtures.postageSkuId), quantity: 1 },
      addressId: shopper.addressId,
      kind: 'normal',
      idempotencyKey: `e2e-mini-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
  expect(created.ok(), `order create failed: ${created.status()} ${await created.text()}`).toBe(
    true,
  );
  return (await created.json()) as { id: string; orderNo: string };
}

/** 收银台's 微信支付, the emulated shopper confirming the sheet; waits for 支付成功. */
export async function payAtMiniCashier(page: Page): Promise<void> {
  const cashier = new CashierPage(page);
  await cashier.expectShown();
  await cashier.pay();
  await new PayResultPage(page).expectPaid();
}

/** An order the shopper paid in the app (a `wechat_mini` payment, so WeChat hears of the shipment). */
export async function arrangeMiniPaidOrder(
  page: Page,
  shopper: MiniShopper,
  shop: Stack,
): Promise<{ id: string; orderNo: string }> {
  const order = await placeOrder(shopper, shop);
  await openFresh(page, miniRoute('packages/order/cashier/index', { orderId: order.id }));
  await payAtMiniCashier(page);
  await expectOrderStatus(shopper, order.id, ['paid']);
  return order;
}

/**
 * 发货 by 顺丰 through the admin API (`POST /admin-api/orders/:id/shipments`), not the domain
 * service: the web process is where the payment domain's hooks are installed, so only there
 * does a shipment queue its report to WeChat (发货信息管理).
 */
export async function shipByExpress(
  adminApi: APIRequestContext,
  shop: Stack,
  orderId: string,
): Promise<void> {
  const shipped = await adminApi.post(`/admin-api/orders/${orderId}/shipments`, {
    data: {
      deliveryMode: 'express',
      lines: [],
      expressCompanyId: String(shop.fixtures.expressCompanyId),
      trackingNo: TRACKING_NO,
    },
  });
  expect(shipped.ok(), `ship failed: ${shipped.status()} ${await shipped.text()}`).toBe(true);
}

/**
 * Waits for the worker to have reported the shipment to WeChat (发货信息管理), after
 * which `GET /orders/:id/wechat-receipt` names the payment and 确认收货 opens
 * WeChat's own component.
 */
export async function waitForWechatReceipt(shopper: MiniShopper, orderId: string): Promise<void> {
  await expect(async () => {
    const response = await shopper.api.get(`/api/v1/orders/${orderId}/wechat-receipt`);
    expect(response.ok(), await response.text()).toBe(true);
    const body = (await response.json()) as { receipt: unknown };
    expect(body.receipt).not.toBeNull();
  }).toPass({ timeout: 20_000 });
}

export async function expectOrderStatus(
  shopper: MiniShopper,
  orderId: string,
  statuses: readonly string[],
): Promise<void> {
  await expect(async () => {
    const response = await shopper.api.get(`/api/v1/orders/${orderId}`);
    const body = (await response.json()) as { status: string };
    expect(statuses).toContain(body.status);
  }).toPass({ timeout: 15_000 });
}
