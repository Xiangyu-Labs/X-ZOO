import { miniRoute, test, expect } from '../src/mini';
import { saveConfig } from '../src/mini-pages/decor-pages';
import { SITE } from '../src/site';
import { shown } from '../src/mini-pages/shown';

/**
 * `GET /api/v1/app/config`, the mini-program's first request and the one read behind every
 * "the shop's own …" in it. `src/seed.ts` writes a
 * shop name and a login logo that differ from anything bundled (`src/site.ts`), so a page that
 * ignored the config would show something else.
 */

test('the app config answers cached and versioned: an ETag, a 304 for it, a new one after a save', async ({
  playwright,
  shop,
  adminApi,
}) => {
  const api = await playwright.request.newContext({
    baseURL: shop.baseUrl,
    extraHTTPHeaders: { 'X-Client-Platform': 'wechat-mini' },
  });
  const first = await api.get('/api/v1/app/config');
  expect(first.status(), await first.text()).toBe(200);
  const etag = first.headers()['etag'];
  expect(etag).toMatch(/^W\/".+"$/);
  expect(first.headers()['x-server-time']).toBeTruthy();
  const body = (await first.json()) as { name: string; version: string; serverTime: string };
  expect(body.name).toBe(SITE.siteName);
  expect(etag).toBe(`W/"${body.version}"`);

  // The same version is a bodyless 304 that still carries the server's clock.
  const again = await api.get('/api/v1/app/config', { headers: { 'If-None-Match': etag! } });
  expect(again.status()).toBe(304);
  expect(again.headers()['x-server-time']).toBeTruthy();

  // Saving a group it is built from drops the cache and moves the version.
  await saveConfig(adminApi, 'wechat-mini', { webviewDomains: 'e2e-version.example.com' });
  try {
    const after = await api.get('/api/v1/app/config', { headers: { 'If-None-Match': etag! } });
    expect(after.status()).toBe(200);
    const moved = (await after.json()) as { version: string; webviewDomains: string[] };
    expect(moved.version).not.toBe(body.version);
    expect(moved.webviewDomains).toEqual(['e2e-version.example.com']);
  } finally {
    await saveConfig(adminApi, 'wechat-mini', { webviewDomains: '' });
  }
  await api.dispose();
});

test("the login page shows the shop's own logo and name, from the app config", async ({
  miniPage: page,
}) => {
  await page.goto(miniRoute('pages/login/index'));
  await expect(shown(page).getByText(SITE.siteName, { exact: true })).toBeVisible();
  await expect(page.locator(`img[src="${SITE.loginLogo}"]`)).toBeAttached();
});
