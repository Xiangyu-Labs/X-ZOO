import { randomBytes } from 'node:crypto';

import type { Page } from '@playwright/test';

import { test as base } from './fixtures';

/**
 * Fixtures for `specs-mini/`: the Taro mini-program, built for H5 as
 * "模拟小程序" (`apps/mini/src/platform/h5-mp-emulation.tsx`), driven as a
 * shopper holding a phone with WeChat on it.
 *
 * What WeChat itself would decide on a phone — who is signed in to WeChat,
 * which number `getPhoneNumber` shares, whether the shopper confirms the
 * payment sheet — is test data here: `wechatUser`, written into the page's
 * `localStorage` before the app starts. Everything after that is the real
 * server: the page gets a `wx.login` code from the harness, the server
 * redeems it against the fake `api.weixin.qq.com`, places the payment on the
 * fake WeChat Pay gateway and learns it was paid from a signed notification.
 */

/** Must match `EMULATION_STORAGE_KEY` in `apps/mini/src/platform/h5-mp-emulation.tsx`. */
const EMULATION_STORAGE_KEY = '__shop_mp_emulation__';

/** Must match `TOKEN_KEY` in `apps/mini/src/features/session/session.ts`. */
const SESSION_TOKEN_KEY = 'shop.session.token';

export interface EmulatedWechatUser {
  openid: string;
  unionid?: string;
  /** What `getPhoneNumber` shares: 11 digits, no country code. */
  phone: string;
  /** What the shopper does with the payment sheet. Default `pay`. */
  payment?: 'pay' | 'cancel' | 'fail';
  /**
   * How WeChat's 确认收货 component ends. Default `confirm`; `confirm-silently` confirms but
   * never calls back, the app only comes back to the foreground.
   */
  receipt?: 'confirm' | 'cancel' | 'fail' | 'confirm-silently';
  /**
   * What 从微信导入 (`chooseInvoiceTitle`) hands over, in WeChat's shape (`type` '0' is a
   * company, '1' a person); `null` = the shopper cancels. Default: a fixed company title.
   */
  invoiceTitle?: {
    type: '0' | '1';
    title: string;
    taxNumber: string;
    companyAddress: string;
    telephone: string;
    bankName: string;
    bankAccount: string;
  } | null;
  /**
   * Whether this WeChat user has agreed to the shop's 用户隐私保护指引. Default `agreed`.
   * `undecided`: the first private API (手机号, 头像, 地址, 图片, 发票抬头) raises the app's
   * privacy sheet, as `onNeedPrivacyAuthorization` does on a phone, and waits for 同意 / 拒绝.
   */
  privacy?: 'agreed' | 'undecided';
  /** How the subscribe-message dialog is answered, for every template. Default `accept`. */
  subscribe?: 'accept' | 'reject';
  /**
   * What 导入微信地址 (`wx.chooseAddress`) returns; `null` = the shopper cancels. Default: the
   * app's fixed 广州 address, which the seeded division (深圳 only) cannot price.
   */
  address?: {
    name: string;
    phone: string;
    province: string;
    city: string;
    district: string;
    detail: string;
    postCode: string | null;
  } | null;
}

/** A 深圳 address 导入微信地址 can hand over: the seeded division prices its freight. */
export const SHENZHEN_WECHAT_ADDRESS = {
  name: '小程序新客',
  phone: '13900001111',
  province: '广东省',
  city: '深圳市',
  district: '南山区',
  detail: '科技园路 3 号',
  postCode: '518000',
} as const;

/** A WeChat user this run has never seen: a new openid and a number nobody registered. */
export function newWechatUser(overrides: Partial<EmulatedWechatUser> = {}): EmulatedWechatUser {
  const digits = BigInt(`0x${randomBytes(6).toString('hex')}`) % 100_000_000n;
  return {
    openid: `o_e2e_${randomBytes(10).toString('hex')}`,
    phone: `139${digits.toString().padStart(8, '0')}`,
    ...overrides,
  };
}

/** Makes `page` the phone of `user`, from its first navigation on. */
export async function holdPhone(page: Page, user: EmulatedWechatUser): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    EMULATION_STORAGE_KEY,
    JSON.stringify(user),
  ] as const);
}

/**
 * The bearer token the app stored after signing in. Taro's H5 `setStorageSync`
 * wraps a value as `{"data": …}`; the raw string is accepted too.
 */
export async function sessionToken(page: Page): Promise<string> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), SESSION_TOKEN_KEY);
  if (!raw) throw new Error('the app has not stored a session token');
  try {
    const parsed = JSON.parse(raw) as { data?: unknown };
    if (typeof parsed.data === 'string') return parsed.data;
  } catch {
    // stored bare
  }
  return raw;
}

/** A Taro H5 route: the hash router, `/#/<page>?query`. */
export function miniRoute(pagePath: string, query: Record<string, string | number> = {}): string {
  const search = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  ).toString();
  return `/#/${pagePath}${search ? `?${search}` : ''}`;
}

export interface MiniFixtures {
  /** The WeChat user holding this test's phone; a new one per test. */
  wechatUser: EmulatedWechatUser;
  /** `page` as that user's phone, with the page-health listeners attached. Not navigated yet. */
  miniPage: Page;
}

export const test = base.extend<MiniFixtures>({
  // eslint-disable-next-line no-empty-pattern
  wechatUser: async ({}, use) => {
    await use(newWechatUser());
  },

  // Depends on the health fixtures so their listeners see the first load.
  miniPage: async ({ page, wechatUser, consoleErrors, failedRequests }, use) => {
    void consoleErrors;
    void failedRequests;
    await holdPhone(page, wechatUser);
    await use(page);
  },
});

export { expect } from './fixtures';
