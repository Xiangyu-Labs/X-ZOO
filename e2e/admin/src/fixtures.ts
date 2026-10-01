import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

import { BASE_URL } from './stack-file';
import { stack, closeStack, type Stack } from './stack';

/**
 * The `test` every spec imports.
 *
 * Three fixtures, and no more: a logged-in page, a logged-in API client, and
 * the database the server is using. Anything else a spec needs it builds in
 * front of the reader.
 */

export interface Fixtures {
  /** A page already logged in as the seeded super admin, sitting on /admin. */
  adminPage: Page;
  /** Same session, for the calls a browser cannot make (or should not have to). */
  adminApi: APIRequestContext;
}

export interface WorkerFixtures {
  shop: Stack;
}

/**
 * Logs in through the real route and returns the cookies.
 *
 * Not through the form: the login *form* is what `auth.spec.ts` tests, and
 * every other spec paying 800ms of typing for it would be a tax with no
 * assertion attached.
 */
export async function loginCookies(
  request: APIRequestContext,
  account: string,
  password: string,
): Promise<void> {
  const response = await request.post('/admin-api/auth/login', {
    data: { account, password },
  });
  expect(
    response.ok(),
    `login as ${account} failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);
}

/**
 * Every cookie-authenticated admin mutation has to pass `handle()`'s CSRF
 * check, which wants `Sec-Fetch-Site` or an allowed `Origin`. A browser sends
 * the first for free; an `APIRequestContext` sends neither, so it sends the
 * second — the same header the SPA's own `fetch` would carry.
 */
export const ORIGIN_HEADERS = { origin: BASE_URL } as const;

export const test = base.extend<Fixtures, WorkerFixtures>({
  shop: [
    // Playwright reads a fixture's dependencies out of the *source text* of
    // its first parameter, so that parameter has to be a destructuring
    // pattern even when nothing is destructured out of it. `eslint`'s
    // `no-empty-pattern` disagrees, and Playwright wins: it throws otherwise.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(await stack());
      await closeStack();
    },
    { scope: 'worker' },
  ],

  adminApi: async ({ playwright, shop }, use) => {
    const request = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: ORIGIN_HEADERS,
    });
    await loginCookies(request, shop.accounts.super!.account, shop.accounts.super!.password);
    await use(request);
    await request.dispose();
  },

  adminPage: async ({ page, shop }, use) => {
    // Log in through the API on the page's own context, so the browser holds
    // the session cookie and every subsequent navigation is a real one.
    await page.goto('/admin/login');
    await loginCookies(page.request, shop.accounts.super!.account, shop.accounts.super!.password);
    await page.goto('/admin');
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await use(page);
  },
});

export { expect };

/**
 * antd toasts (`message.success`) live in a portal at the end of `<body>` and
 * disappear after three seconds. Asserting on them is asserting that the
 * operator was told the thing happened, which is half of what these flows
 * promise; the other half is asserted against the database or the API.
 */
export function toast(page: Page, text: string) {
  return page.locator('.ant-message-notice').filter({ hasText: text });
}

/** The dialog both `ModalForm` and `DrawerForm` render. */
export function dialog(page: Page) {
  return page.getByRole('dialog');
}

/**
 * A button label, tolerant of the space antd puts inside it.
 *
 * antd's `Button` inserts a space between the two characters of a
 * *two-CJK-character* label (两字按钮加空格), so `<Button>登录</Button>` has the
 * accessible name `登 录` and `getByRole('button', { name: '登录' })` matches
 * nothing. It applies to most buttons in this admin — 保存, 取消, 确定, 上传,
 * 发货, 同意 — and not to 新建商品 or 保存并发布, so a spec cannot hard-code
 * either spelling and be right.
 *
 * Rather than re-implement antd's rule, this allows whitespace between every
 * pair of characters and anchors both ends, so `cjk('保存')` still refuses to
 * match `保存并发布`.
 *
 * The optional leading `icon-name ` is the second half of the same problem: a
 * `<Button icon={<SaveOutlined />}>保存</Button>` renders an `<span
 * role="img" aria-label="save">`, so its accessible name is `save 保存` — the
 * DIY toolbar's save button, the palette's `font-size 文本标题`, every icon
 * button in the shell. The prefix is always an ASCII antd icon name, so
 * allowing one at the front costs nothing and the end stays anchored.
 */
export function cjk(label: string): RegExp {
  const chars = [...label].map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^\\s*(?:[a-z][a-z0-9-]*\\s+)?${chars.join('\\s*')}\\s*$`);
}
