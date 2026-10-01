import { test, expect } from '../src/mini';
import {
  block,
  createClaimableCoupon,
  createDecorPage,
  DecorHomePage,
  decorDocument,
  decorPreviewToken,
  designateDecorHome,
  MicroPage,
  publishDecorPage,
  saveConfig,
  saveDecorDraft,
} from '../src/mini-pages/decor-pages';
import { currentQuery } from '../src/mini-pages/order-pages';
import { shown } from '../src/mini-pages/shown';

/**
 * 页面装修 v2, from the operator's 发布 to what a shopper's phone shows (plan §12: "decor from
 * publish to visible in the storefront"). The operator's side is the admin API F2's editor
 * calls — `decor.spec.ts` in `e2e/admin` drives the editor itself — and the shopper's side is the
 * mini-program's 微页面, rendered by `@shop/storefront-blocks` from what the resolver served.
 *
 * Pictures point at a CDN the run never reaches (`keepOffline` answers them with a pixel).
 */

const IMAGE = 'https://cdn.example.com/uploads/decor/e2e-banner.jpg';
const ICON = 'https://cdn.example.com/uploads/decor/e2e-icon.png';
const toRoute = (route: string) => ({ kind: 'route', to: { route, params: {} } }) as const;

/** Every block type a 微页面 may hold that needs no shopper, with a word to find it by. */
function everyBlockPage(title: string, headline: string, productIds: readonly string[]) {
  return decorDocument(title, [
    block('b-search', 'searchBar', {
      placeholder: '搜索装修商品',
      hotWords: [],
      shape: 'round',
      sticky: false,
    }),
    block('b-carousel', 'carousel', {
      slides: [{ image: IMAGE, link: toRoute('couponCenter'), alt: '装修轮播' }],
      height: 340,
      autoplay: false,
      interval: 3000,
      indicator: 'dots',
      indicatorColor: '#ffffff80',
      indicatorActiveColor: '#ffffff',
    }),
    block('b-notice', 'notice', {
      label: '公告',
      lines: [{ text: '装修公告：全场包邮' }, { text: '装修公告：假期照常发货' }],
      mode: 'static',
      interval: 4000,
    }),
    block('b-nav', 'navGrid', {
      items: [
        { icon: ICON, label: '装修领券', link: toRoute('couponCenter') },
        { icon: ICON, label: '装修商品', link: { kind: 'product', id: productIds[0] } },
      ],
      columns: 4,
      rows: 1,
      paging: false,
      iconShape: 'circle',
    }),
    block('b-cube', 'imageCube', {
      layout: 'row2',
      cells: [
        { image: IMAGE, link: toRoute('couponCenter') },
        { image: IMAGE, link: { kind: 'product', id: productIds[0] } },
      ],
      height: 360,
      gap: 10,
    }),
    block('b-hotspot', 'hotspotImage', {
      image: IMAGE,
      hotspots: [{ x: 0, y: 0, w: 100, h: 100, label: '装修热区', link: toRoute('couponCenter') }],
    }),
    block('b-title', 'titleBar', {
      title: headline,
      subtitle: '装修副标题',
      align: 'left',
      moreText: '更多',
    }),
    block(
      'b-grid',
      'productGrid',
      {
        source: { mode: 'manual', ids: [...productIds] },
        layout: 'grid2',
        titleLines: 2,
        showMarketPrice: false,
        showTag: false,
      },
      2,
    ),
    block('b-rich', 'richText', {
      html: '<p><strong>装修须知</strong></p><p>所有商品均为隐私包装发货。</p>',
    }),
    block('b-spacer', 'spacer', { height: 24, line: 'solid', inset: true }),
  ]);
}

const EVERY_BLOCK = [
  'searchBar',
  'carousel',
  'notice',
  'navGrid',
  'imageCube',
  'hotspotImage',
  'titleBar',
  'productGrid',
  'richText',
  'spacer',
];

test('a page published in the admin shows each of its blocks in order, and follows the next publish', async ({
  miniPage: page,
  shop,
  adminApi,
  consoleErrors,
  failedRequests,
}) => {
  // The postage product first, though it was created after the multi-spec one: the operator's
  // order is kept.
  const picked = [shop.fixtures.postageProductId, shop.fixtures.multiSpecProductId].map(String);
  let draft = await createDecorPage(
    adminApi,
    `E2E 小程序装修 ${Date.now()}`,
    everyBlockPage('E2E 装修页', '装修标题 第一版', picked),
  );
  expect(await publishDecorPage(adminApi, draft, 'e2e 第一版')).toBe(1);

  const micro = new MicroPage(page);
  await micro.open(draft.id);
  await expect(micro.block('titleBar')).toContainText('装修标题 第一版');
  expect(await micro.blockTypes()).toEqual(EVERY_BLOCK);

  await expect(micro.block('searchBar')).toContainText('搜索装修商品');
  await expect(micro.block('carousel').locator('img').first()).toBeVisible();
  await expect(micro.block('notice')).toContainText('装修公告：全场包邮');
  await expect(micro.block('notice')).toContainText('装修公告：假期照常发货');
  await expect(micro.block('navGrid')).toContainText('装修领券');
  await expect(micro.block('imageCube').locator('img')).toHaveCount(2);
  await expect(micro.block('hotspotImage').locator('img')).toBeVisible();
  await expect(micro.block('titleBar')).toContainText('装修副标题');
  await expect(micro.block('richText')).toContainText('装修须知');
  await expect(micro.block('richText').locator('strong')).toHaveText('装修须知');
  await expect(micro.block('spacer')).toHaveCount(1);

  // DECOR-013: a manual list serves the operator's picks in the operator's order.
  const grid = micro.block('productGrid');
  await expect(grid).toContainText('E2E 运费商品');
  await expect(grid).toContainText('E2E 多规格商品');
  const gridText = await grid.innerText();
  expect(gridText.indexOf('E2E 运费商品')).toBeLessThan(gridText.indexOf('E2E 多规格商品'));

  // A block's link goes where the operator pointed it: 装修领券 → 领券中心.
  await shown(page).getByText('装修领券', { exact: true }).click();
  await expect(page).toHaveURL(/packages\/promo\/coupons\/index/);

  // The next publish is what the next visit shows; the old revision is not served from cache.
  draft = await saveDecorDraft(
    adminApi,
    draft,
    everyBlockPage('E2E 装修页', '装修标题 第二版', [...picked].reverse()),
  );
  expect(await publishDecorPage(adminApi, draft, 'e2e 第二版')).toBe(2);
  await micro.open(draft.id);
  await expect(micro.block('titleBar')).toContainText('装修标题 第二版');
  const reordered = await micro.block('productGrid').innerText();
  expect(reordered.indexOf('E2E 多规格商品')).toBeLessThan(reordered.indexOf('E2E 运费商品'));
  expect(currentQuery(page).get('id')).toBe(draft.id);

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('DECOR-012: the editor’s preview token shows the draft under a banner, and nothing without it', async ({
  miniPage: page,
  shop,
  adminApi,
}) => {
  const draft = await createDecorPage(
    adminApi,
    `E2E 装修预览 ${Date.now()}`,
    everyBlockPage('E2E 预览页', '装修标题 草稿', [String(shop.fixtures.postageProductId)]),
  );
  const token = await decorPreviewToken(adminApi, draft);

  const micro = new MicroPage(page);
  await micro.open(draft.id, token);
  await expect(micro.previewBanner()).toHaveText('草稿预览：仅供查看效果，发布后顾客才能看到');
  await expect(micro.block('titleBar')).toContainText('装修标题 草稿');

  // Never published: without the token the storefront has no such page.
  await micro.open(draft.id);
  await expect(shown(page).getByText('页面不存在', { exact: true })).toBeVisible();
  await expect(micro.blocks()).toHaveCount(0);

  // A token for another page opens nothing either.
  const other = await createDecorPage(
    adminApi,
    `E2E 装修预览另一页 ${Date.now()}`,
    everyBlockPage('E2E 另一页', '装修标题 另一页', [String(shop.fixtures.postageProductId)]),
  );
  await micro.open(other.id, token);
  await expect(shown(page).getByText('预览已过期', { exact: true })).toBeVisible();
  await expect(micro.blocks()).toHaveCount(0);
});

test('a web-view link opens only a 业务域名 the shop listed; any other link is copied', async ({
  miniPage: page,
  context,
  adminApi,
  consoleErrors,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const allowed = 'https://e2e-allowed.example.com/activity?from=decor';
  const refused = 'https://e2e-refused.example.com/elsewhere';
  await saveConfig(adminApi, 'wechat-mini', { webviewDomains: 'e2e-allowed.example.com' });
  try {
    const draft = await createDecorPage(
      adminApi,
      `E2E 装修外链 ${Date.now()}`,
      decorDocument('E2E 外链页', [
        block('b-links', 'navGrid', {
          items: [
            { icon: ICON, label: '允许外链', link: { kind: 'webview', url: allowed } },
            { icon: ICON, label: '拒绝外链', link: { kind: 'webview', url: refused } },
          ],
          columns: 4,
          rows: 1,
          paging: false,
          iconShape: 'circle',
        }),
      ]),
    );
    await publishDecorPage(adminApi, draft, 'e2e 外链');

    const micro = new MicroPage(page);
    await micro.open(draft.id);

    // Not on the list: copied for a browser, and the shopper stays on the page.
    await shown(page).getByText('拒绝外链', { exact: true }).click();
    await expect(shown(page).getByText('链接已复制，请在浏览器中打开')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(refused);
    await expect(page).toHaveURL(/packages\/page\/index/);

    // On the list: the web-view page, carrying the whole URL.
    await shown(page).getByText('允许外链', { exact: true }).click();
    await expect(page).toHaveURL(/packages\/content\/webview\/index/);
    expect(currentQuery(page).get('url')).toBe(allowed);

    expect(consoleErrors).toEqual([]);
  } finally {
    await saveConfig(adminApi, 'wechat-mini', { webviewDomains: '' });
  }
});

test('DECOR-015: a visitor claims from the 首页 优惠券 block after signing up, and the reloaded page says 去使用', async ({
  miniPage: page,
  shop,
  adminApi,
  consoleErrors,
  failedRequests,
}) => {
  const templateId = await createClaimableCoupon(adminApi, `E2E 首页券 ${Date.now()}`, '8.00');
  const draft = await createDecorPage(
    adminApi,
    `E2E 首页领券 ${Date.now()}`,
    decorDocument('E2E 领券首页', [
      block('b-coupons', 'couponList', {
        title: '首页领券',
        showMore: false,
        source: { mode: 'manual', ids: [templateId] },
        layout: 'stack',
      }),
    ]),
    'home',
  );
  await publishDecorPage(adminApi, draft, 'e2e 首页领券');
  await designateDecorHome(adminApi, draft.id);
  try {
    const home = new DecorHomePage(page);
    await home.open();
    const ticket = home.couponTicket(templateId);
    await expect(ticket).toHaveAttribute('data-action', 'claim');
    await expect(ticket).toContainText('领取');

    // A WeChat user the shop has never seen: 领取 needs an account, the login page comes back.
    await ticket.click();
    await expect(page).toHaveURL(/pages\/login\/index\?redirect=/);
    await shown(page).getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' }).click();
    await shown(page).getByText('手机号快速登录', { exact: true }).click();
    await expect(page).toHaveURL(/pages\/index\/index/);

    // Back on 首页, now signed in: the page was fetched again and nothing is claimed yet.
    await expect(ticket).toHaveAttribute('data-action', 'claim');
    await ticket.click();
    await expect(shown(page).getByText('领取成功')).toBeVisible();
    // One per shopper: the reloaded page's personal layer turns the button into 去使用.
    await expect(ticket).toHaveAttribute('data-action', 'use');
    await expect(ticket).toContainText('去使用');

    await ticket.click();
    await expect(page).toHaveURL(/packages\/promo\/my-coupons\/index/);

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  } finally {
    await designateDecorHome(adminApi, shop.fixtures.decorHomeId);
  }
});
