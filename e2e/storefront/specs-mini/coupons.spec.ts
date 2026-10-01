import { adminCreate, adminDelete, adminGrant } from '@shop/core/coupon';
import { userCoupons } from '@shop/db/schema/coupon';
import { eq } from 'drizzle-orm';

import { test, expect } from '../src/mini';
import type { Stack } from '../src/stack';
import { OrderDetailPage, OrderListPage } from '../src/mini-pages/order-pages';
import { CheckoutPage, ProductPage } from '../src/mini-pages/shopping-pages';
import { returningShopper } from '../src/mini-pages/shopping-shopper';
import { shown } from '../src/mini-pages/shown';

/**
 * Coupons past the seeded ¥5 满减券 (`shopping.spec.ts`, `promo.spec.ts`): one scoped to a
 * category, and one stacked on a presale — where only the line's adjustments tell the ¥10
 * activity and the ¥5 coupon apart, and the order pages must still print the presale price.
 *
 * Each coupon template is this test's own and is deleted afterwards, so no other journey's
 * 确认订单 offers it.
 */

type TemplateInput = Parameters<typeof adminCreate>[1];

function template(name: string, scope: Partial<TemplateInput>): TemplateInput {
  return {
    name,
    scope: 'categories',
    claimMode: 'manual',
    status: 'active',
    discountAmount: '7.00',
    minSpend: '0.00',
    validityMode: 'days_after_claim',
    validFrom: undefined,
    validTo: undefined,
    validDays: 30,
    claimFrom: undefined,
    claimTo: undefined,
    isUnlimitedSupply: false,
    totalCount: 10,
    perUserLimit: 1,
    giftMinOrderAmount: undefined,
    sortOrder: 0,
    productIds: [],
    categoryIds: [],
    ...scope,
  } as TemplateInput;
}

async function withTemplate(
  shop: Stack,
  input: TemplateInput,
  userId: number,
  run: (userCouponId: string) => Promise<void>,
): Promise<void> {
  const created = await adminCreate(shop.ctx, input);
  try {
    await adminGrant(shop.ctx, { id: created.id }, { userIds: [String(userId)] });
    const [held] = await shop.db
      .select({ id: userCoupons.id })
      .from(userCoupons)
      .where(eq(userCoupons.templateId, Number(created.id)));
    await run(String(held!.id));
  } finally {
    await shop.db.delete(userCoupons).where(eq(userCoupons.templateId, Number(created.id)));
    await adminDelete(shop.ctx, { id: created.id });
  }
}

test('确认订单 itemises the freight and takes a category-scoped coupon for a product in that category', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright, { coupon: true });
  await withTemplate(
    shop,
    template('E2E 品类券', { categoryIds: [String(shop.fixtures.categoryId)] }),
    shopper.userId,
    async () => {
      const product = new ProductPage(page);
      await product.open(shop.fixtures.postageProductId);
      await product.barButton('立即购买').click();
      await product.sheetButton('立即购买').click();

      // The ¥7 品类券 beats the ¥5 满减券: 39 + 6 − 7.
      const checkout = new CheckoutPage(page);
      await checkout.expectShown();
      await expect(checkout.couponCell()).toContainText('-¥7.00');
      await expect(checkout.bar()).toContainText('38.00');
      // The freight it charges is its own line: ¥6.00 to the 深圳 address.
      await expect(
        shown(page).locator('.shop-cell__row').filter({ hasText: /^运费/ }),
      ).toContainText('¥6.00');

      // Both are offered and usable.
      await checkout.couponCell().click();
      await expect(checkout.couponSheet()).toBeVisible();
      await expect(shown(page).getByRole('radio', { name: /^E2E 品类券/ })).toBeEnabled();
      await expect(shown(page).getByRole('radio', { name: /^E2E 满减券/ })).toBeEnabled();
    },
  );
  await shopper.api.dispose();
});

test('a presale with a stacked coupon still shows the presale price on the order pages', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
}) => {
  // Found by this test (I2), fixed in J1: the order pages read the line's adjustments
  // (`apps/mini/src/lib/order-price.ts`) rather than print `unitPrice` and lump the activity
  // into 优惠券.
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  await withTemplate(
    shop,
    template('E2E 预售叠加券', {
      scope: 'products',
      discountAmount: '5.00',
      productIds: [String(shop.fixtures.activityProductId)],
    }),
    shopper.userId,
    async (userCouponId) => {
      // 确认订单 never picks a coupon for an activity; the checkout API takes one named.
      const created = await shopper.api.post('/api/v1/orders', {
        data: {
          source: 'buy-now',
          item: { skuId: String(shop.fixtures.activitySkuId), quantity: 1 },
          addressId: shopper.addressId,
          kind: 'presale',
          kindMeta: { activityId: String(shop.fixtures.presaleActivityId) },
          userCouponId,
          idempotencyKey: `e2e-mini-presale-coupon-${Date.now()}`,
        },
      });
      expect(created.ok(), await created.text()).toBe(true);
      const order = (await created.json()) as { id: string; orderNo: string };
      try {
        // 订单详情: the line at ¥78.00 (not the ¥88.00 catalogue price), the coupon's own
        // ¥5.00, ¥73.00 to pay.
        const detail = new OrderDetailPage(page);
        await detail.open(order.id);
        const card = shown(page).locator('#order-detail');
        await expect(card).toContainText('E2E 活动商品');
        await expect(card).toContainText('78.00');
        await expect(shown(page).locator('.order-price')).toContainText('-¥5.00');
        await expect(shown(page).locator('.order-price')).toContainText('73.00');
        await expect(card).not.toContainText('88.00');

        // 我的订单 (待付款): the same order, the same prices.
        const list = new OrderListPage(page);
        await list.open('unpaid');
        const listed = list.card(order.orderNo);
        await expect(listed).toContainText('73.00');
        await expect(listed).not.toContainText('88.00');
      } finally {
        await shopper.api.post(`/api/v1/orders/${order.id}/cancel`, { data: {} });
      }
    },
  );
  await shopper.api.dispose();
});
