import { test, expect, cjk, ORIGIN_HEADERS } from '../src/fixtures';
import { BASE_URL } from '../src/stack-file';

/**
 * Login, and the lockout that follows five wrong passwords.
 *
 * `auth.int.test.ts` already asserts the throttle against the service. What it
 * cannot assert is that the *operator* is told — that the 429 reaches the form
 * as a readable sentence rather than a blank page — and that the cookie the
 * browser is handed actually carries the session on the next navigation.
 */

test('a wrong password is refused, and says nothing about the account', async ({ page, shop }) => {
  await page.goto('/admin/login');
  await page.getByLabel('账号').fill(shop.accounts.super!.account);
  await page.getByLabel('密码').fill('definitely-not-the-password');
  await page.getByRole('button', { name: cjk('登录') }).click();

  const alert = page.getByTestId('login-error');
  await expect(alert).toBeVisible();
  const wrongPassword = (await alert.textContent())?.trim();

  // The same form, an account that does not exist: the operator must not be
  // able to tell the two apart.
  await page.getByLabel('账号').fill('nobody-by-that-name');
  await page.getByLabel('密码').fill('definitely-not-the-password');
  await page.getByRole('button', { name: cjk('登录') }).click();
  await expect(alert).toBeVisible();
  expect((await alert.textContent())?.trim()).toBe(wrongPassword);

  await expect(page).toHaveURL(/\/admin\/login/);
});

test('a good password lands on the shell, and the session survives a reload', async ({
  page,
  shop,
}) => {
  await page.goto('/admin/login?next=/admin/system/roles');
  await page.getByLabel('账号').fill(shop.accounts.super!.account);
  await page.getByLabel('密码').fill(shop.accounts.super!.password);
  await page.getByRole('button', { name: cjk('登录') }).click();

  // `?next` is honoured, and sanitised — this one is a legitimate admin path.
  await expect(page).toHaveURL(/\/admin\/system\/roles$/);
  await expect(page.getByTestId('user-menu')).toBeVisible();

  const cookie = (await page.context().cookies(BASE_URL)).find((c) => c.name === 'admin_session');
  expect(cookie, 'the session cookie must be set').toBeDefined();
  expect(cookie!.httpOnly, 'a script must never be able to read the session').toBe(true);
  expect(cookie!.sameSite).toBe('Lax');
  expect(cookie!.value).toMatch(/^[a-z2-9]{40}$/);

  await page.reload();
  await expect(page.getByTestId('user-menu')).toBeVisible();
});

test('logging out ends the session for the API too, not just for the tab', async ({
  adminPage,
}) => {
  await adminPage.getByTestId('user-menu').click();
  await adminPage.getByText('退出登录').click();
  await expect(adminPage).toHaveURL(/\/admin\/login/);

  // The cookie being gone locally proves nothing: the question is whether the
  // token still works. It must not.
  const response = await adminPage.request.get('/admin-api/auth/me');
  expect(response.status()).toBe(401);
});

test('the sixth attempt in the window is refused for being the sixth', async ({
  page,
  playwright,
  shop,
}) => {
  const account = shop.accounts.lockable!.account;
  const request = await playwright.request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: ORIGIN_HEADERS,
  });

  // Five wrong passwords: refused for being wrong.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await request.post('/admin-api/auth/login', {
      data: { account, password: `wrong-${attempt}` },
    });
    expect(response.status(), `attempt ${attempt}`).toBe(401);
    expect((await response.json()).code).toBe('AUTH_INVALID_CREDENTIALS');
  }

  // The sixth is refused for being the sixth — and, crucially, the *right*
  // password is refused too. A throttle that let the correct password through
  // would not be a throttle.
  const locked = await request.post('/admin-api/auth/login', {
    data: { account, password: shop.accounts.lockable!.password },
  });
  expect(locked.status()).toBe(429);
  const body = await locked.json();
  expect(body.code).toBe('AUTH_TOO_MANY_ATTEMPTS');
  expect(body.details?.retryAfterMs, 'the operator is told how long to wait').toBeGreaterThan(0);

  // And the operator sees that sentence, rather than a blank screen.
  await page.goto('/admin/login');
  await page.getByLabel('账号').fill(account);
  await page.getByLabel('密码').fill(shop.accounts.lockable!.password);
  await page.getByRole('button', { name: cjk('登录') }).click();
  await expect(page.getByTestId('login-error')).toContainText('登录尝试过于频繁');

  // Another account is unaffected: the bucket is per account, not global.
  const other = await request.post('/admin-api/auth/login', {
    data: { account: shop.accounts.super!.account, password: shop.accounts.super!.password },
  });
  expect(other.status()).toBe(200);

  await request.dispose();
});

test('a cookie session without a same-site marker cannot mutate', async ({ adminApi, shop }) => {
  // `adminApi` is logged in. Repeat one of its own mutations from an origin
  // the server does not know, and it must be refused — the browser's SameSite
  // is a second lock, not the only one.
  const ok = await adminApi.put('/admin-api/system/config/sms', {
    data: { values: { provider: 'none' } },
  });
  expect(ok.status()).toBe(200);

  const crossSite = await adminApi.put('/admin-api/system/config/sms', {
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    data: { values: { provider: 'none' } },
  });
  expect(crossSite.status()).toBe(403);
  expect((await crossSite.json()).code).toBe('AUTH_CROSS_SITE_BLOCKED');

  expect(shop.accounts.super).toBeDefined();
});
