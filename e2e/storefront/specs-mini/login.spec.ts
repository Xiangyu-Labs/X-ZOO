import { hashPassword } from '@shop/core/auth';
import { codeKey } from '@shop/core/sms';
import { userSessions } from '@shop/db/schema/auth';
import { cartItems } from '@shop/db/schema/cart';
import { users } from '@shop/db/schema/user';
import { wechatIdentities } from '@shop/db/schema/wechat';
import type { Page } from '@playwright/test';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { miniRoute, newWechatUser, sessionToken, test, expect } from '../src/mini';
import type { Stack } from '../src/stack';
import { CartPage, openTab, ProductPage } from '../src/mini-pages/shopping-pages';
import {
  arrangeCartLine,
  cartQuantities,
  returningShopper,
  signedInToken,
} from '../src/mini-pages/shopping-shopper';
import { openFresh, shown } from '../src/mini-pages/shown';

/**
 * How a WeChat shopper gets and keeps a session in the mini-program (docs/mini/auth.md):
 * silently, with `wx.login`, when the shop knows the openid; with an SMS code when the shop
 * wants a phone number and WeChat's quick phone button is not used (手机号快速登录 itself is
 * `new-shopper-buys.spec.ts`'s); with the account's password under 其他方式; through the
 * privacy sheet WeChat raises before sharing the phone number with a shop the shopper has not
 * agreed with yet; and, when the server stops honouring the token, renewed once with a fresh
 * `wx.login` and the failed request replayed — reads and writes alike.
 */

const MINI_LOGIN = '/api/v1/auth/sessions/wechat-mini';

/** Every `POST` to the mini sign-in the page makes from now on. */
function countSignIns(page: Page): { count: () => number } {
  let count = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === MINI_LOGIN) count += 1;
  });
  return { count: () => count };
}

/** Every API response the page gets from now on, as `METHOD /path STATUS`, in order. */
function recordApi(page: Page): string[] {
  const seen: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/v1/'))
      seen.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
  });
  return seen;
}

/** Reads the code `issueCode()` stored — `sms:code:<scene>:<phone>`, field `code`. */
async function issuedCode(shop: Stack, phone: string): Promise<string> {
  let code: string | null = null;
  await expect(async () => {
    code = await shop.redis.hget(codeKey('login', phone), 'code');
    expect(code, `no login code issued for ${phone}`).toMatch(/^\d{6}$/);
  }).toPass({ timeout: 10_000 });
  return code!;
}

test('a WeChat user the shop knows is signed in on opening the app, with no login page', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const signIns = countSignIns(page);
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  expect(page.url()).not.toMatch(/pages\/login/);
  expect(signIns.count()).toBe(1);

  // The token is the shopper's own: the profile answers with their number.
  const profile = await shopper.api.get('/api/v1/profile');
  expect(profile.status(), await profile.text()).toBe(200);
  expect(((await profile.json()) as { phone: string }).phone).toBe(wechatUser.phone);

  // The app reads the shopper's own data with it: the cart they filled elsewhere.
  await arrangeCartLine(shopper.api, shop.fixtures.postageSkuId);
  const cart = new CartPage(page);
  await openTab(page, '购物车');
  await expect(cart.row('E2E 运费商品')).toBeVisible();

  // A cold start keeps the stored token: no second wx.login.
  await openFresh(page, miniRoute('pages/index/index'));
  await openTab(page, '购物车');
  await expect(cart.row('E2E 运费商品')).toBeVisible();
  expect(signIns.count()).toBe(1);

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  await shopper.api.dispose();
});

test('a new WeChat user ticks the terms, signs up with an SMS code, and a wrong code leaves it usable', async ({
  miniPage: page,
  wechatUser,
  shop,
  consoleErrors,
}) => {
  const phone = wechatUser.phone;
  await shop.redis.del(codeKey('login', phone), `sms:resend:login:${phone}`);

  // The silent sign-in finds no account for this openid: the login page asks for a phone.
  await page.goto(miniRoute('pages/login/index'));

  // Nothing is shared with the shop before the terms are ticked.
  const phoneAsked = { count: 0 };
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/auth/sessions/wechat-mini/phone'))
      phoneAsked.count += 1;
  });
  await shown(page).getByText('手机号快速登录', { exact: true }).click();
  await expect(shown(page).getByText('请先阅读并同意用户协议和隐私政策')).toBeVisible();
  expect(phoneAsked.count).toBe(0);

  await shown(page).getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }).click();
  await shown(page).getByText('短信验证码登录', { exact: true }).click();
  await shown(page).locator('input[placeholder="请输入手机号"]').fill(phone);
  await shown(page).getByText('获取验证码', { exact: true }).click();
  await expect(shown(page).getByText(/秒后重发$/)).toBeVisible();
  const code = await issuedCode(shop, phone);

  // A wrong code is refused, counted, and the right one still works.
  const wrong = code === '000000' ? '111111' : '000000';
  await shown(page).locator('input[placeholder="请输入验证码"]').fill(wrong);
  await shown(page).locator('.login__actions').getByText('登录', { exact: true }).click();
  await expect(async () => {
    expect(await shop.redis.hget(codeKey('login', phone), 'attempts')).toBe('1');
  }).toPass({ timeout: 10_000 });
  await expect(page).toHaveURL(/pages\/login\/index/);

  await shown(page).locator('input[placeholder="请输入验证码"]').fill(code);
  await shown(page).locator('.login__actions').getByText('登录', { exact: true }).click();

  // Signed up, and back on 首页 (the login page had no redirect).
  await expect(page).toHaveURL(/pages\/index\/index/);
  await signedInToken(page);
  const [user] = await shop.db
    .select({ id: users.id, registerSource: users.registerSource })
    .from(users)
    .where(eq(users.phone, phone));
  expect(user, `no user with phone ${phone}`).toBeDefined();
  expect(user!.registerSource).toBe('wechat_mini');
  // The openid that asked is bound to the account, so the next wx.login signs straight in.
  const identities = await shop.db
    .select({ openid: wechatIdentities.openid, platform: wechatIdentities.platform })
    .from(wechatIdentities)
    .where(eq(wechatIdentities.userId, user!.id));
  expect(identities).toEqual([{ openid: wechatUser.openid, platform: 'mini' }]);
  // The code is spent.
  expect(await shop.redis.exists(codeKey('login', phone))).toBe(0);

  expect(consoleErrors).toEqual([]);
});

const PASSWORD = 'Mini-pass-1';

/** A shopper's account with a password and a phone of its own, known to no WeChat openid. */
async function passwordAccount(
  shop: Stack,
): Promise<{ id: number; account: string; phone: string }> {
  const { phone } = newWechatUser();
  const account = `pw-${phone}`;
  const [row] = await shop.db
    .insert(users)
    .values({
      account,
      phone,
      nickname: '密码顾客',
      passwordHash: await hashPassword(PASSWORD, 4),
      passwordAlgo: 'bcrypt',
      passwordVersion: 1,
      registerSource: 'h5',
    })
    .returning({ id: users.id });
  return { id: row!.id, account, phone };
}

test("SMOKE-004: 密码登录 under 其他方式 reaches an authenticated screen, and a wrong password is its field's error", async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const owner = await passwordAccount(shop);

  // The silent sign-in finds no account for this openid (phone-required, a bindToken parked);
  // 其他方式 offers the password.
  await page.goto(miniRoute('pages/login/index'));
  await expect(shown(page).getByText('手机号快速登录', { exact: true })).toBeVisible();
  await shown(page).getByRole('button', { name: '密码登录' }).click();
  await shown(page).locator('input[placeholder="手机号或账号"]').fill(owner.phone);
  await shown(page).locator('input[placeholder="请输入密码"]').fill('not-the-password');
  await shown(page).getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }).click();
  const login = shown(page)
    .locator('.login__actions')
    .getByRole('button', { name: '登录', exact: true });
  await login.click();
  await expect(shown(page).getByText('账号或密码不正确')).toBeVisible();
  await expect(page).toHaveURL(/pages\/login\/index/);

  await shown(page).locator('input[placeholder="请输入密码"]').fill(PASSWORD);
  await login.click();

  // Signed in, and home (the login page had no redirect).
  await expect(page).toHaveURL(/pages\/index\/index/);
  const token = await signedInToken(page);
  const api = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, 'X-Client-Platform': 'wechat-mini' },
  });
  const profile = await api.get('/api/v1/profile');
  expect(profile.status(), await profile.text()).toBe(200);
  expect(((await profile.json()) as { phone: string }).phone).toBe(owner.phone);

  // A mini-program session of that account, and the parked openid is now linked to it: the
  // password login carried the bindToken (AUTH-009, docs/mini/auth.md「密码登录」). The wrong
  // password before it did not spend the token.
  const live = await shop.db
    .select({ platform: userSessions.platform })
    .from(userSessions)
    .where(and(eq(userSessions.userId, owner.id), isNull(userSessions.revokedAt)));
  expect(live).toEqual([{ platform: 'wechat-mini' }]);
  const linked = await shop.db
    .select({ userId: wechatIdentities.userId, platform: wechatIdentities.platform })
    .from(wechatIdentities)
    .where(eq(wechatIdentities.openid, wechatUser.openid));
  expect(linked).toEqual([{ userId: owner.id, platform: 'mini' }]);

  // The password session ends (expired, or 退出所有设备 elsewhere). The next read 401s and the
  // renewal's fresh wx.login signs in to the same account, silently.
  await arrangeCartLine(api, shop.fixtures.postageSkuId);
  const revoked = await api.delete('/api/v1/auth/sessions');
  expect(revoked.ok(), await revoked.text()).toBe(true);
  await api.dispose();
  const signIns = countSignIns(page);
  const seen = recordApi(page);
  await openTab(page, '购物车');
  await expect(new CartPage(page).row('E2E 运费商品')).toBeVisible();
  expect(signIns.count()).toBe(1);
  expect(page.url()).not.toMatch(/pages\/login/);
  const renewed = await sessionToken(page);
  expect(renewed).not.toBe(token);
  const again = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${renewed}`, 'X-Client-Platform': 'wechat-mini' },
  });
  const renewedProfile = await again.get('/api/v1/profile');
  expect(renewedProfile.status(), await renewedProfile.text()).toBe(200);
  expect(((await renewedProfile.json()) as { phone: string }).phone).toBe(owner.phone);
  await again.dispose();

  expect(consoleErrors).toEqual([]);
  // The wrong password, then exactly the 401s the renewal answered.
  const renewedAway = seen.filter((line) => line.endsWith(' 401'));
  expect(renewedAway.length).toBeGreaterThan(0);
  expect(failedRequests).toEqual(['POST /api/v1/auth/sessions/password 401', ...renewedAway]);
});

test("AUTH-010: a write that meets an ended password session is not replayed as the account this phone's WeChat belongs to, and the shopper is back at the login page", async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const owner = await passwordAccount(shop);

  // The silent sign-in finds no account for this openid yet (phone-required); 其他方式 is there.
  await page.goto(miniRoute('pages/login/index'));
  await expect(shown(page).getByText('手机号快速登录', { exact: true })).toBeVisible();

  // Meanwhile the openid becomes another account's: whoever else uses this phone's WeChat.
  const [holder] = await shop.db
    .insert(users)
    .values({
      account: `mini-${wechatUser.phone}`,
      phone: wechatUser.phone,
      nickname: '另一位顾客',
      registerSource: 'wechat_mini',
    })
    .returning({ id: users.id });
  await shop.db
    .insert(wechatIdentities)
    .values({ userId: holder!.id, platform: 'mini', openid: wechatUser.openid });

  // 密码登录: the link is refused (the openid is taken, AUTH-009) and the app signs in without
  // it, so the password account's session and this phone's openid belong to two accounts.
  await shown(page).getByRole('button', { name: '密码登录' }).click();
  await shown(page).locator('input[placeholder="手机号或账号"]').fill(owner.phone);
  await shown(page).locator('input[placeholder="请输入密码"]').fill(PASSWORD);
  await shown(page).getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }).click();
  await shown(page)
    .locator('.login__actions')
    .getByRole('button', { name: '登录', exact: true })
    .click();
  await expect(page).toHaveURL(/pages\/index\/index/);
  // Where the login page went, the shopper is told this WeChat stays with the other account (H6).
  await expect(shown(page).getByText('此微信已关联其他账号，本账号需用密码登录')).toBeVisible();
  const api = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: {
      Authorization: `Bearer ${await signedInToken(page)}`,
      'X-Client-Platform': 'wechat-mini',
    },
  });
  const profile = await api.get('/api/v1/profile');
  expect(((await profile.json()) as { phone: string }).phone).toBe(owner.phone);
  const linked = await shop.db
    .select({ userId: wechatIdentities.userId })
    .from(wechatIdentities)
    .where(eq(wechatIdentities.openid, wechatUser.openid));
  expect(linked).toEqual([{ userId: holder!.id }]);

  // The sheet is ready to add; then the password session ends (expired, 退出所有设备 elsewhere).
  const product = new ProductPage(page);
  await product.open(shop.fixtures.multiSpecProductId);
  await product.barButton('加入购物车').click();
  await product.specValue('白').click();
  await product.specValue('M').click();
  const revoked = await api.delete('/api/v1/auth/sessions');
  expect(revoked.ok(), await revoked.text()).toBe(true);
  await api.dispose();
  const signIns = countSignIns(page);
  const seen = recordApi(page);
  await product.sheetButton('加入购物车').click();

  // The renewal's wx.login reached the other account: not kept, the shopper signed out and
  // asked to sign in again — a line on the login page, not a toast (the add-to-cart's own error
  // toast replaced that one).
  await expect(page).toHaveURL(/pages\/login\/index/);
  await expect(shown(page).getByText('登录已过期，请重新登录')).toBeVisible();
  expect(signIns.count()).toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('shop.session.token')))
    .toBeNull();

  // The write went out once, as the password account, and landed in nobody's cart.
  expect(seen.filter((line) => line.startsWith('POST /api/v1/cart/items'))).toEqual([
    'POST /api/v1/cart/items 401',
  ]);
  const lines = await shop.db
    .select({ userId: cartItems.userId })
    .from(cartItems)
    .where(inArray(cartItems.userId, [owner.id, holder!.id]));
  expect(lines).toEqual([]);
  // The session the renewal minted for the other account was ended, not left behind.
  await expect
    .poll(() =>
      shop.db
        .select({ id: userSessions.id })
        .from(userSessions)
        .where(and(eq(userSessions.userId, holder!.id), isNull(userSessions.revokedAt))),
    )
    .toEqual([]);

  expect(consoleErrors).toEqual([]);
  // The refused link, then only the 401s the renewal let stand.
  expect(failedRequests.filter((line) => !line.endsWith(' 401'))).toEqual([
    'POST /api/v1/auth/sessions/password 409',
  ]);
});

test.describe('the privacy sheet WeChat raises before 手机号快速登录', () => {
  // This WeChat user has not agreed to the shop's 用户隐私保护指引 yet.
  // eslint-disable-next-line no-empty-pattern
  test.use({ wechatUser: async ({}, use) => use(newWechatUser({ privacy: 'undecided' })) });

  /** What the harness hands out for `getPhoneNumber`, as the page asks for it. */
  function countPhoneCodes(page: Page): { count: () => number } {
    let count = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/__e2e/mini/phone-code') count += 1;
    });
    return { count: () => count };
  }

  test('同意 lets the phone number through and the shopper is signed in', async ({
    miniPage: page,
    wechatUser,
    shop,
    consoleErrors,
    failedRequests,
  }) => {
    const phoneCodes = countPhoneCodes(page);
    await page.goto(miniRoute('pages/login/index'));
    await shown(page).getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }).click();
    await shown(page).getByRole('button', { name: '手机号快速登录' }).click();

    // WeChat holds getPhoneNumber; the app's sheet says why it is asking.
    const sheet = shown(page).getByRole('dialog', { name: '用户隐私保护提示' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(
      '为了登录、绑定账号，接收订单与售后通知，我们需要你同意《用户隐私保护指引》',
    );
    expect(phoneCodes.count()).toBe(0);

    await sheet.getByRole('button', { name: '同意' }).click();

    // The number goes through and the sign-up finishes: home, with the openid bound.
    await expect(page).toHaveURL(/pages\/index\/index/);
    await signedInToken(page);
    expect(phoneCodes.count()).toBe(1);
    const [user] = await shop.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, wechatUser.phone));
    expect(user, `no user with phone ${wechatUser.phone}`).toBeDefined();
    await expect(shown(page).getByRole('dialog', { name: '用户隐私保护提示' })).toHaveCount(0);

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test('拒绝 fails only that tap; the next tap asks again, and 同意 then goes on', async ({
    miniPage: page,
    wechatUser,
    shop,
    consoleErrors,
  }) => {
    const phoneCodes = countPhoneCodes(page);
    await page.goto(miniRoute('pages/login/index'));
    await shown(page).getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }).click();
    const quick = shown(page).getByRole('button', { name: '手机号快速登录' });
    await quick.click();

    const sheet = shown(page).getByRole('dialog', { name: '用户隐私保护提示' });
    await sheet.getByRole('button', { name: '拒绝' }).click();

    // Nothing was shared: no phone code, no account, still on the login page, told why.
    await expect(shown(page).getByText('未同意隐私保护指引，可改用短信验证码登录')).toBeVisible();
    await expect(sheet).toHaveCount(0);
    expect(phoneCodes.count()).toBe(0);
    await expect(page).toHaveURL(/pages\/login\/index/);
    const none = await shop.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, wechatUser.phone));
    expect(none).toEqual([]);

    // Browsing goes on; the next tap on the button asks again (WeChat did not remember a no).
    await quick.click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: '同意' }).click();
    await expect(page).toHaveURL(/pages\/index\/index/);
    await signedInToken(page);
    expect(phoneCodes.count()).toBe(1);

    expect(consoleErrors).toEqual([]);
  });
});

test('a session the server stopped honouring is renewed once, and the reads that failed are replayed', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  await arrangeCartLine(shopper.api, shop.fixtures.postageSkuId);
  const before = await sessionToken(page);

  // Signed out on the server (another device's 退出登录 everywhere, an expiry): the app still
  // holds the token and does not know.
  const revoked = await shopper.api.delete('/api/v1/auth/sessions');
  expect(revoked.ok(), await revoked.text()).toBe(true);

  const signIns = countSignIns(page);
  const api = recordApi(page);
  await openTab(page, '购物车');
  const cart = new CartPage(page);
  await expect(cart.row('E2E 运费商品')).toBeVisible();

  // One renewal for however many requests failed together, each failure replayed once.
  expect(signIns.count()).toBe(1);
  const failed = api.filter((line) => line.endsWith(' 401'));
  expect(failed.length).toBeGreaterThan(0);
  for (const line of failed) {
    const replay = line.replace(/ 401$/, ' 200');
    expect(api.slice(api.indexOf(line) + 1), `${line} was not replayed`).toContain(replay);
  }
  const after = await sessionToken(page);
  expect(after).not.toBe(before);

  // The new token is the account's one live session, minted for the mini-program.
  const live = await shop.db
    .select({ platform: userSessions.platform })
    .from(userSessions)
    .where(and(eq(userSessions.userId, shopper.userId), isNull(userSessions.revokedAt)));
  expect(live).toEqual([{ platform: 'wechat-mini' }]);
  expect(page.url()).not.toMatch(/pages\/login/);

  expect(consoleErrors).toEqual([]);
  // What failed is exactly the 401s the renewal answered.
  expect(failedRequests.length).toBe(failed.length);
  expect(failedRequests.every((line) => line.endsWith(' 401'))).toBe(true);
  await shopper.api.dispose();
});

test('a write that meets an expired session is replayed once after renewal, not lost or doubled', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  await arrangeCartLine(shopper.api, shop.fixtures.postageSkuId);
  const cart = new CartPage(page);
  await cart.open();
  await expect(cart.row('E2E 运费商品')).toBeVisible();

  // The server forgets the session while the cart is on screen.
  const revoked = await shopper.api.delete('/api/v1/auth/sessions');
  expect(revoked.ok(), await revoked.text()).toBe(true);
  const signIns = countSignIns(page);
  const api = recordApi(page);

  await cart.increase('E2E 运费商品').click();

  await expect(async () => {
    const token = await sessionToken(page);
    const probe = await playwright.request.newContext({
      baseURL: shop.baseUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${token}`, 'X-Client-Platform': 'wechat-mini' },
    });
    const quantities = await cartQuantities(probe);
    await probe.dispose();
    expect(quantities.get(String(shop.fixtures.postageSkuId))).toBe(2);
  }).toPass({ timeout: 10_000 });
  await expect(cart.bar()).toContainText('结算(2)');

  expect(signIns.count()).toBe(1);
  const writes = api.filter((line) => /^(POST|PUT|PATCH|DELETE) \/api\/v1\/cart\//.test(line));
  expect(writes.filter((line) => line.endsWith(' 401'))).toHaveLength(1);
  expect(writes.filter((line) => / 2\d\d$/.test(line))).toHaveLength(1);
  // Still 2 a moment later: the replay was the only one. (A fresh API context: the shopper's
  // old one holds the revoked token.)
  const fresh = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: {
      Authorization: `Bearer ${await signedInToken(page)}`,
      'X-Client-Platform': 'wechat-mini',
    },
  });
  expect((await cartQuantities(fresh)).get(String(shop.fixtures.postageSkuId))).toBe(2);

  expect(consoleErrors).toEqual([]);
  await fresh.dispose();
  await shopper.api.dispose();
});
