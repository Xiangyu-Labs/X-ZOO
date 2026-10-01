import type { APIRequestContext, Browser, Page } from '@playwright/test';

import { keepOffline } from '../src/fixtures';
import { test, expect, miniRoute } from '../src/mini';
import { RefundApplyPage } from '../src/mini-pages/aftersale-pages';
import { OrderDetailPage, currentQuery } from '../src/mini-pages/order-pages';
import {
  expectOrderStatus,
  payAtMiniCashier,
  signUpFromOrders,
  waitForWechatReceipt,
} from '../src/mini-pages/order-shopper';
import { CheckoutPage, ProductPage } from '../src/mini-pages/shopping-pages';
import { openFresh } from '../src/mini-pages/shown';

/**
 * One order through every hand that touches it, with nothing seeded in between:
 *
 *   后台建商品 → 小程序立即购买 → 微信支付 (the fake gateway) → 后台发货 (the
 *   order page's 发货 dialog) → 小程序确认收货 → 小程序申请仅退款 → 后台同意
 *   (the 售后 page) → 退款成功 → 交易统计 moved by exactly this order.
 *
 * Every other journey starts from arranged data at one of these joints; this
 * one proves the joints meet. The admin half runs in a desktop browser on the
 * same stack, logged in as the seeded super admin.
 *
 * The statistics block cache is switched off for the duration (and restored):
 * it keys by day, so a "before" read would otherwise be served back as "after".
 * The suite runs on one worker, so nothing else moves the day's figures between
 * the two reads.
 */

const PRICE = '30.00';

async function tradeToday(adminApi: APIRequestContext) {
  const response = await adminApi.get('/admin-api/stats/trade');
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { metrics: { key: string; value: number }[] };
  const value = (key: string) => body.metrics.find((metric) => metric.key === key)!.value;
  return {
    revenue: value('revenue'),
    goodsPaidAmount: value('goodsPaidAmount'),
    refundAmount: value('refundAmount'),
    paidOrderCount: value('paidOrderCount'),
  };
}

async function setStatsCache(adminApi: APIRequestContext, cacheSeconds: number): Promise<void> {
  const saved = await adminApi.put('/admin-api/system/config/stats', {
    data: { values: { cacheSeconds } },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
}

/** The admin console in a desktop browser, as the seeded super admin. */
async function adminConsole(
  browser: Browser,
  baseUrl: string,
  account: { account: string; password: string },
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1440, height: 900 },
  });
  await keepOffline(context);
  const page = await context.newPage();
  const login = await page.request.post('/admin-api/auth/login', { data: account });
  expect(login.ok(), await login.text()).toBe(true);
  return page;
}

/** A button label, tolerant of the space antd puts between two CJK characters. */
const cjk = (label: string) => new RegExp(`^\\s*${[...label].join('\\s*')}\\s*$`);

test('an order goes from a new product to a refund, and the day’s figures follow it', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  browser,
  adminApi,
  consoleErrors,
  failedRequests,
}) => {
  test.setTimeout(4 * 60_000);
  await setStatsCache(adminApi, 0);
  try {
    const before = await tradeToday(adminApi);

    // -- 后台建商品 -----------------------------------------------------------
    const template = await (
      await adminApi.get(`/admin-api/catalog/products/${shop.fixtures.postageProductId}`)
    ).json();
    const name = `贯通商品 ${Date.now()}`;
    const created = await adminApi.post('/admin-api/catalog/products', {
      data: {
        name,
        sliderImages: [template.imageUrl],
        kind: 'physical',
        status: 'on_shelf',
        imageUrl: template.imageUrl,
        displaySalesBoost: 0,
        specMode: false,
        specs: [],
        skus: [
          {
            specValues: {},
            price: PRICE,
            stock: 5,
            isDefault: true,
            isVisible: true,
            sortOrder: 0,
          },
        ],
        freightMode: 'free',
        purchaseLimitMode: 'none',
        minPurchaseQuantity: 1,
        isHot: false,
        isNew: false,
        isBest: false,
        isBenefit: false,
        isRecommended: false,
        sortOrder: 0,
        descriptionHtml: '',
        // The shopper signs up fresh, so the seeded 满减券 (granted to the two
        // seeded shoppers only) cannot discount it.
        categoryIds: [String(shop.fixtures.categoryId)],
        labelIds: [],
        protectionIds: [],
        params: [],
        recommendedProductIds: [],
        giftCouponIds: [],
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const productId = ((await created.json()) as { id: string }).id;

    // -- 小程序立即购买 → 微信支付 ------------------------------------------------
    const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);
    const product = new ProductPage(page);
    await product.open(productId);
    await expect(product.name()).toHaveText(name);
    await product.barButton('立即购买').click();
    await product.sheetButton('立即购买').click();
    const checkout = new CheckoutPage(page);
    await checkout.expectShown();
    await expect(checkout.bar()).toContainText(PRICE);
    await checkout.submit();
    await payAtMiniCashier(page);
    const orderId = currentQuery(page).get('orderId')!;
    await expectOrderStatus(shopper, orderId, ['paid']);
    const { orderNo } = (await (await shopper.api.get(`/api/v1/orders/${orderId}`)).json()) as {
      orderNo: string;
    };

    // -- 后台发货, through the order page ----------------------------------------
    const admin = await adminConsole(browser, shop.baseUrl, shop.admin);
    await admin.goto(`/admin/orders/${orderId}`);
    await admin.getByRole('button', { name: cjk('发货') }).click();
    const shipDialog = admin.getByRole('dialog');
    await shipDialog.getByLabel('物流公司').click();
    await admin.getByTitle('顺丰速运', { exact: true }).click();
    await shipDialog.getByLabel('运单号').fill('SF2026092400001');
    await shipDialog.getByRole('button', { name: cjk('保存') }).click();
    await expect(shipDialog).toBeHidden();
    await waitForWechatReceipt(shopper, orderId);

    // -- 小程序确认收货 ----------------------------------------------------------
    const detail = new OrderDetailPage(page);
    await detail.open(orderId);
    await detail.expectHeadline('已发货');
    await detail.action('确认收货').click();
    await detail.expectHeadline('已收货');
    await expectOrderStatus(shopper, orderId, ['received', 'completed']);

    // -- 小程序申请仅退款 --------------------------------------------------------
    await openFresh(page, miniRoute('packages/aftersale/apply/index', { orderId }));
    const apply = new RefundApplyPage(page);
    await apply.expectOpen();
    await apply.kind('仅退款').click();
    await apply.chooseReason('不想要了');
    const applied = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/refunds' &&
        response.request().method() === 'POST',
    );
    await apply.submit();
    const refund = (await (await applied).json()) as { id: string; amount: string };
    expect(refund.amount).toBe(PRICE);

    // -- 后台同意, on the 售后 page ----------------------------------------------
    await admin.goto('/admin/trade/refunds');
    const row = admin.getByRole('row').filter({ hasText: orderNo });
    await row.getByRole('button', { name: cjk('同意') }).click();
    const approveDialog = admin.getByRole('dialog');
    await approveDialog.getByLabel('备注').fill('贯通：同意退款');
    await approveDialog.getByRole('button', { name: '确认同意' }).click();
    await expect(approveDialog).toBeHidden();

    await expect(async () => {
      const response = await shopper.api.get(`/api/v1/refunds/${refund.id}`);
      expect(((await response.json()) as { status: string }).status).toBe('succeeded');
    }).toPass({ timeout: 30_000 });
    await detail.open(orderId);
    await detail.expectHeadline('已退款');
    await admin.context().close();

    // -- 交易统计 -------------------------------------------------------------
    // Paid and refunded the same day: one more paid order, the goods on both
    // sides, and 营业额 back where it was.
    const after = await tradeToday(adminApi);
    expect(after.paidOrderCount - before.paidOrderCount).toBe(1);
    expect(after.goodsPaidAmount - before.goodsPaidAmount).toBeCloseTo(Number(PRICE), 2);
    expect(after.refundAmount - before.refundAmount).toBeCloseTo(Number(PRICE), 2);
    expect(after.revenue - before.revenue).toBeCloseTo(0, 2);
  } finally {
    await setStatsCache(adminApi, 60);
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
