import type { Browser, BrowserContext, Page } from '@playwright/test';
import { groupbuyGroups, groupbuyMembers } from '@shop/db/schema/groupbuy';
import { orders } from '@shop/db/schema/order';
import { effects } from '@shop/db/schema/system';
import { and, eq } from 'drizzle-orm';

import { DEVICE } from '../src/device';
import { keepOffline } from '../src/fixtures';
import { holdPhone, newWechatUser, test, expect, type EmulatedWechatUser } from '../src/mini';
import { currentQuery } from '../src/mini-pages/order-pages';
import { expectOrderStatus, payAtMiniCashier } from '../src/mini-pages/order-shopper';
import {
  CouponCenterPage,
  GroupbuyActivityPage,
  GroupbuyTeamPage,
  MyCouponsPage,
  MyGroupbuysPage,
  PresaleActivityPage,
} from '../src/mini-pages/promo-pages';
import { CashierPage, CheckoutPage, ProductPage } from '../src/mini-pages/shopping-pages';
import { returningShopper } from '../src/mini-pages/shopping-shopper';
import { shown } from '../src/mini-pages/shown';
import { BASE_URL } from '../src/stack-file';

/**
 * The mini-program's marketing pages, end to end (stream D): a group buy two phones fill, a
 * group buy nobody joins that fails and refunds (虚拟成团 is off), a presale bought in full, and
 * a coupon claimed at 领券中心 and spent at 确认订单.
 *
 * Seeded (`src/seed.ts`): 「E2E 拼团活动」 ¥68, 2 seats, 24 h; 「E2E 预售活动」 ¥78, full
 * payment, ships 7 days after payment; 「E2E 满减券」 ¥5 off, no minimum, manual claim, 5 per
 * shopper. The activity product ships free; the postage product is ¥39 + ¥6 to 深圳.
 *
 * Arranged, not driven: the accounts (`returningShopper`, a WeChat user the shop already knows),
 * and in the expiry journey the team's clock, which is moved to now in the database the way
 * time passing would; the worker settles the team and refunds it as it would in production.
 */

/** A second shopper's phone: its own browser context, as offline as the first. */
async function secondPhone(
  browser: Browser,
  user: EmulatedWechatUser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    ...DEVICE,
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  await keepOffline(context);
  const page = await context.newPage();
  await holdPhone(page, user);
  return { context, page };
}

test('a shopper opens a group buy, a friend joins on another phone, and the team completes', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  browser,
  consoleErrors,
  failedRequests,
}) => {
  const leader = await returningShopper(page, wechatUser, shop, playwright);

  // 拼团商品 says how the team works, including what happens if it does not fill.
  const activity = new GroupbuyActivityPage(page);
  await activity.open(shop.fixtures.groupBuyActivityId);
  await expect(activity.title()).toHaveText('E2E 拼团活动');
  await expect(activity.rules()).toContainText('2 人成团');
  await expect(activity.rules()).toContainText('到时间未凑齐，拼团自动取消，已付款项原路退回');

  // 发起拼团 → 确认订单 → 收银台.
  await activity.startTeam();
  const checkout = new CheckoutPage(page);
  await checkout.expectShown();
  await expect(checkout.bar()).toContainText('68.00');
  await checkout.submit();
  await new CashierPage(page).expectShown();
  const leaderOrderId = currentQuery(page).get('orderId')!;
  await payAtMiniCashier(page);
  await expectOrderStatus(leader, leaderOrderId, ['paid']);

  // 我的拼团 → the team: one seat taken, one to go, and 邀请好友参团.
  const mine = new MyGroupbuysPage(page);
  await mine.open();
  await mine.team('E2E 拼团活动').click();
  const team = new GroupbuyTeamPage(page);
  await expect(team.headline()).toHaveText('还差 1 人成团');
  await expect(team.seats()).toHaveAttribute('aria-label', '2 人团，已有 1 人');
  await expect(team.action('邀请好友参团')).toBeVisible();
  const groupId = new URL(page.url().replace('/#/', '/')).searchParams.get('id')!;

  // A friend opens the shared team on their own phone and joins it.
  const friendUser = newWechatUser();
  const friend = await secondPhone(browser, friendUser);
  try {
    const friendShopper = await returningShopper(friend.page, friendUser, shop, playwright);
    const friendTeam = new GroupbuyTeamPage(friend.page);
    await friendTeam.open(groupId);
    await expect(friendTeam.headline()).toHaveText('还差 1 人成团');
    await friendTeam.join();
    const friendCheckout = new CheckoutPage(friend.page);
    await friendCheckout.expectShown();
    await friendCheckout.submit();
    await new CashierPage(friend.page).expectShown();
    const friendOrderId = currentQuery(friend.page).get('orderId')!;
    await payAtMiniCashier(friend.page);
    await expectOrderStatus(friendShopper, friendOrderId, ['paid']);

    // Both phones see the team complete.
    await friendTeam.open(groupId);
    await friendTeam.waitForHeadline('拼团成功');
    await friendShopper.api.dispose();
  } finally {
    await friend.context.close();
  }

  await team.open(groupId);
  await team.waitForHeadline('拼团成功');
  await expect(team.seats()).toHaveAttribute('aria-label', '2 人团，已有 2 人');
  await expect(team.action('查看订单')).toBeVisible();

  const [row] = await shop.db
    .select({ status: groupbuyGroups.status, seatsTaken: groupbuyGroups.seatsTaken })
    .from(groupbuyGroups)
    .where(eq(groupbuyGroups.id, Number(groupId)));
  expect(row).toEqual({ status: 'succeeded', seatsTaken: 2 });

  // 我的拼团 files it under 已成团.
  await mine.open();
  await mine.tab('已成团').click();
  await expect(mine.team('E2E 拼团活动').first()).toHaveAccessibleName('E2E 拼团活动，拼团成功');

  await leader.api.dispose();
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('a team nobody joins fails when its time is up, and the shopper is refunded', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);

  // The team is opened and paid for (the pages of the journey above).
  const activity = new GroupbuyActivityPage(page);
  await activity.open(shop.fixtures.groupBuyActivityId);
  await activity.startTeam();
  const checkout = new CheckoutPage(page);
  await checkout.expectShown();
  await checkout.submit();
  await new CashierPage(page).expectShown();
  const orderId = currentQuery(page).get('orderId')!;
  await payAtMiniCashier(page);
  await expectOrderStatus(shopper, orderId, ['paid']);

  const [member] = await shop.db
    .select({ groupId: groupbuyMembers.groupId })
    .from(groupbuyMembers)
    .where(eq(groupbuyMembers.orderId, Number(orderId)));
  expect(member, 'the paid order has no team').toBeDefined();
  const groupId = member!.groupId;

  const team = new GroupbuyTeamPage(page);
  await team.open(groupId);
  await expect(team.headline()).toHaveText('还差 1 人成团');

  // Nobody joins, and the 24 hours pass: the team's clock and its timer are moved to now.
  const now = new Date();
  await shop.db
    .update(groupbuyGroups)
    .set({ expiresAt: new Date(now.getTime() - 1_000) })
    .where(eq(groupbuyGroups.id, groupId));
  await shop.db
    .update(effects)
    .set({ nextRunAt: now })
    .where(
      and(
        eq(effects.scope, 'groupbuy'),
        eq(effects.scopeId, String(groupId)),
        eq(effects.eventType, 'groupbuy.expire'),
      ),
    );

  // The worker fails the team and refunds the order; the page says so, honestly.
  await team.waitForHeadline('拼团未成功，已退款', 90_000);
  await expect(shown(page).getByText('款项已原路退回，请留意到账')).toBeVisible();
  await expect(team.action('查看订单')).toBeVisible();
  await expect(team.action('再开一团')).toBeVisible();

  const [group] = await shop.db
    .select({ status: groupbuyGroups.status })
    .from(groupbuyGroups)
    .where(eq(groupbuyGroups.id, groupId));
  expect(group?.status).toBe('failed');

  // 我的拼团 files it under 未成团, refunded.
  const mine = new MyGroupbuysPage(page);
  await mine.open();
  await mine.tab('未成团').click();
  await expect(mine.team('E2E 拼团活动').first()).toHaveAccessibleName(
    'E2E 拼团活动，未成团，已退款',
  );

  await shopper.api.dispose();
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('a presale is booked and paid in full, and says when it ships', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);

  // Full payment only: the page says there is no balance to pay later.
  const presale = new PresaleActivityPage(page);
  await presale.open(shop.fixtures.presaleActivityId);
  await expect(presale.rules()).toContainText('全款预订，付款后 7 天内发货');
  await expect(presale.rules()).toContainText('下单时支付全部货款，无需另付尾款');

  await presale.book();
  const checkout = new CheckoutPage(page);
  await checkout.expectShown();
  await expect(checkout.bar()).toContainText('78.00');
  await checkout.submit();
  const cashier = new CashierPage(page);
  await cashier.expectShown();
  await expect(cashier.amount()).toContainText('78.00');
  const orderId = currentQuery(page).get('orderId')!;
  await payAtMiniCashier(page);
  await expectOrderStatus(shopper, orderId, ['paid']);

  const [order] = await shop.db
    .select({ kind: orders.kind, payableAmount: orders.payableAmount })
    .from(orders)
    .where(eq(orders.id, Number(orderId)));
  expect(order).toEqual({ kind: 'presale', payableAmount: '78.00' });

  await shopper.api.dispose();
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('a coupon claimed at 领券中心 waits in 我的优惠券 and comes off at 确认订单', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await returningShopper(page, wechatUser, shop, playwright);
  const templateId = shop.fixtures.couponTemplateId;

  const center = new CouponCenterPage(page);
  await center.open();
  await center.claim(templateId, 'E2E 满减券');
  await expect(center.coupon(templateId)).toContainText('已领 1/5 张');

  const wallet = new MyCouponsPage(page);
  await wallet.open('unused');
  await expect(wallet.list('unused')).toContainText('E2E 满减券');

  // Bought at full price, the claimed coupon is applied at 确认订单: 39 + 6 − 5.
  const product = new ProductPage(page);
  await product.open(shop.fixtures.postageProductId);
  await product.barButton('立即购买').click();
  await expect(product.sheet()).toBeVisible();
  await product.sheetButton('立即购买').click();
  const checkout = new CheckoutPage(page);
  await checkout.expectShown();
  await expect(checkout.couponCell()).toContainText('-¥5.00');
  await expect(checkout.bar()).toContainText('40.00');
  await checkout.submit();
  await new CashierPage(page).expectShown();
  const orderId = currentQuery(page).get('orderId')!;
  await payAtMiniCashier(page);
  await expectOrderStatus(shopper, orderId, ['paid']);

  // Spent: it has left 可使用 for 已使用.
  await wallet.open('used');
  await expect(wallet.list('used')).toContainText('E2E 满减券');
  await wallet.open('unused');
  await expect(wallet.list('unused')).not.toContainText('E2E 满减券');

  await shopper.api.dispose();
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
