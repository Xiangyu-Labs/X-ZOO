import type { APIRequestContext } from '@playwright/test';
import { wechatMiniCodes } from '@shop/db/schema/wechat';
import { eq } from 'drizzle-orm';

import { test, expect } from '../src/mini';
import type { Stack } from '../src/stack';
import {
  block,
  createDecorPage,
  decorDocument,
  MicroPage,
  publishDecorPage,
} from '../src/mini-pages/decor-pages';
import { GroupbuyActivityPage } from '../src/mini-pages/promo-pages';
import { ProductPage } from '../src/mini-pages/shopping-pages';
import { returningShopper } from '../src/mini-pages/shopping-shopper';
import { openFresh, shown } from '../src/mini-pages/shown';

/**
 * A 小程序码 opens the page it was made for (SHARE-001). The shopper's app asks for a code
 * (`GET /api/v1/share/mini-codes`, what the poster draws); the server takes the page from the
 * route catalogue and the scene from `encodeScene`, and asks WeChat (the fake
 * `api.weixin.qq.com`) for the picture. What WeChat would encode into that picture is the
 * `(page, scene)` the server cached in `wechat_mini_codes`; scanning it starts the app on that
 * page with `scene` URI-encoded in the query, which is what the phone here is handed. The app
 * decodes the scene back into the route's params (`readRouteParams`).
 */

interface Code {
  page: string;
  scene: string;
}

/** Asks for the code of `route` as the shopper, and reads back what WeChat was asked to encode. */
async function miniCode(
  api: APIRequestContext,
  shop: Stack,
  route: string,
  id?: string | number,
): Promise<Code> {
  const query = new URLSearchParams({ route, ...(id === undefined ? {} : { id: String(id) }) });
  const response = await api.get(`/api/v1/share/mini-codes?${query.toString()}`);
  expect(response.status(), await response.text()).toBe(200);
  const { url } = (await response.json()) as { url: string };
  const rows = await shop.db
    .select({ page: wechatMiniCodes.page, scene: wechatMiniCodes.scene })
    .from(wechatMiniCodes)
    .where(eq(wechatMiniCodes.url, url));
  expect(rows, `no cached code for ${url}`).toHaveLength(1);
  return rows[0]!;
}

/** Scanning `code`: WeChat starts the app on its page with the scene, URI-encoded. */
function scanned(code: Code): string {
  // The release version's cache key is the bare page; another version prefixes `<env>:`.
  expect(code.page).not.toContain(':');
  return `/#/${code.page}?scene=${encodeURIComponent(code.scene)}`;
}

test('SHARE-001: a 小程序码 opens the product, activity, coupon or decor page it was made for', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  adminApi,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);

  // 商品详情: `id=<n>`.
  const product = await miniCode(shopper.api, shop, 'product', shop.fixtures.postageProductId);
  expect(product).toEqual({
    page: 'pages/product/index',
    scene: `id=${shop.fixtures.postageProductId}`,
  });
  await openFresh(page, scanned(product));
  await expect(new ProductPage(page).name()).toHaveText('E2E 运费商品');

  // 拼团商品 and 预售商品, in their sub-packages.
  const groupbuy = await miniCode(shopper.api, shop, 'groupbuy', shop.fixtures.groupBuyActivityId);
  await openFresh(page, scanned(groupbuy));
  await expect(new GroupbuyActivityPage(page).title()).toHaveText('E2E 拼团活动');

  const presale = await miniCode(shopper.api, shop, 'presale', shop.fixtures.presaleActivityId);
  await openFresh(page, scanned(presale));
  await expect(shown(page).locator('#activity-title')).toHaveText('E2E 预售活动');

  // 领券中心 takes no params: its scene is `_`, which WeChat requires to be non-empty.
  const coupons = await miniCode(shopper.api, shop, 'couponCenter');
  expect(coupons.scene).toBe('_');
  await openFresh(page, scanned(coupons));
  await expect(page).toHaveURL(/packages\/promo\/coupons\/index/);
  await expect(shown(page).locator('#coupon-center')).toBeVisible();

  // A published 微页面.
  const draft = await createDecorPage(
    adminApi,
    `E2E 分享微页面 ${Date.now()}`,
    decorDocument('E2E 分享页', [
      block('b-title', 'titleBar', {
        title: '扫码打开的微页面',
        subtitle: '',
        align: 'left',
        moreText: '更多',
      }),
    ]),
  );
  await publishDecorPage(adminApi, draft, 'e2e 分享');
  const micro = await miniCode(shopper.api, shop, 'page', draft.id);
  await openFresh(page, scanned(micro));
  await expect(new MicroPage(page).block('titleBar')).toContainText('扫码打开的微页面');

  // The same page and scene again is the cached code, not a new WeChat call.
  const again = await miniCode(shopper.api, shop, 'product', shop.fixtures.postageProductId);
  expect(again).toEqual(product);

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  await shopper.api.dispose();
});

test("a product's 分享 sheet makes a poster carrying the product's 小程序码", async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  const product = new ProductPage(page);
  await product.open(shop.fixtures.postageProductId);

  await shown(page).getByRole('button', { name: '分享' }).click();
  await expect(shown(page).getByText('微信好友', { exact: true })).toBeVisible();
  const code = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/share/mini-codes',
  );
  await shown(page).getByRole('button', { name: '生成分享海报' }).click();

  // The poster asks for this product's code, and is ready to save once drawn.
  const answered = await code;
  expect(answered.status()).toBe(200);
  expect(new URL(answered.url()).searchParams.get('id')).toBe(
    String(shop.fixtures.postageProductId),
  );
  await expect(shown(page).getByText('保存到相册', { exact: true })).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  await shopper.api.dispose();
});
