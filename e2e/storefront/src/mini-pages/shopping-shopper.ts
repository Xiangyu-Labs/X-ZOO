import type { APIRequestContext, Page, PlaywrightWorkerArgs } from '@playwright/test';
import { adminGrant as couponAdminGrant } from '@shop/core/coupon';
import { addressCreate } from '@shop/core/user';
import { users } from '@shop/db/schema/user';
import { wechatIdentities } from '@shop/db/schema/wechat';

import { expect } from '../fixtures';
import { miniRoute, type EmulatedWechatUser } from '../mini';
import { userActor } from '../seed';
import type { Stack } from '../stack';
import type { MiniShopper } from './order-shopper';
import { openFresh } from './shown';

/**
 * What the shopping journeys arrange rather than drive: a WeChat user the shop already knows
 * (an account with a phone, bound to this openid, so the silent `wx.login` signs straight in),
 * with a default address in the seeded 深圳 division. Signing up is journey 1's
 * (`new-shopper-buys.spec.ts`) and the guest spec's.
 */
export async function returningShopper(
  page: Page,
  wechatUser: EmulatedWechatUser,
  shop: Stack,
  playwright: PlaywrightWorkerArgs['playwright'],
  options: { coupon?: boolean } = {},
): Promise<MiniShopper> {
  const [user] = await shop.db
    .insert(users)
    .values({
      account: `mini-${wechatUser.phone}`,
      phone: wechatUser.phone,
      nickname: '老顾客',
      registerSource: 'wechat_mini',
    })
    .returning({ id: users.id });
  await shop.db
    .insert(wechatIdentities)
    .values({ userId: user!.id, platform: 'mini', openid: wechatUser.openid });
  const address = await addressCreate(shop.ctx.as(userActor(user!.id)), {
    receiverName: '老顾客',
    receiverPhone: wechatUser.phone,
    ...shop.fixtures.division,
    provinceName: '广东省',
    cityName: '深圳市',
    districtName: '南山区',
    detail: '科技园路 7 号',
    isDefault: true,
  });
  if (options.coupon) {
    await couponAdminGrant(
      shop.ctx,
      { id: String(shop.fixtures.couponTemplateId) },
      { userIds: [String(user!.id)] },
    );
  }

  // The app signs in on its own: the openid is known and the account has a phone.
  await openFresh(page, miniRoute('pages/index/index'));
  const token = await signedInToken(page);
  const api = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, 'X-Client-Platform': 'wechat-mini' },
  });
  return { userId: user!.id, addressId: String(address.id), api };
}

/** Waits for the app to have stored a session token, and returns it. */
export async function signedInToken(page: Page): Promise<string> {
  let token = '';
  await expect(async () => {
    const raw = await page.evaluate(() => window.localStorage.getItem('shop.session.token'));
    expect(raw, 'the app has not signed in').toBeTruthy();
    try {
      const parsed = JSON.parse(raw!) as { data?: unknown };
      token = typeof parsed.data === 'string' ? parsed.data : raw!;
    } catch {
      token = raw!;
    }
  }).toPass({ timeout: 15_000 });
  return token;
}

/** The shopper's cart as the server has it: quantity by SKU id. */
export async function cartQuantities(api: APIRequestContext): Promise<Map<string, number>> {
  const response = await api.get('/api/v1/cart?pageSize=100');
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { items: { skuId: string; quantity: number }[] };
  return new Map(body.items.map((item) => [item.skuId, item.quantity]));
}

/** One line in the cart through the API, for journeys about what happens after. */
export async function arrangeCartLine(
  api: APIRequestContext,
  skuId: number,
  quantity = 1,
): Promise<void> {
  const response = await api.post('/api/v1/cart/items', {
    data: { skuId: String(skuId), quantity },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
