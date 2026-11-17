import type { Locator, Page } from '@playwright/test';

import { expect } from '../fixtures';
import { miniRoute } from '../mini';
import { openFresh, shown } from './shown';

/**
 * Page objects for the mini-program's marketing pages (`apps/mini/src/packages/promo`) and the
 * 拼团 / 预售 parts of 商品详情: 拼团进度, 我的拼团, 领券中心, 我的优惠券. Locators are the words a
 * shopper reads, plus the few element ids the pages set for this (`#product-name`,
 * `#team-headline`, `#team-actions`, `#coupon-<templateId>`, …).
 */

/** The activity's own SKU sheet (拼团 / 预售), when it is up. */
export class ActivitySkuSheet {
  constructor(readonly page: Page) {}

  root(): Locator {
    return shown(this.page).locator('.shop-sheet--shown.activity-sku');
  }

  async expectShown() {
    await expect(this.root()).toBeVisible();
  }

  /** The sheet's own confirm button (it says what the page's button says). */
  async confirm(label: string) {
    const button = this.root().locator('.shop-sheet__footer').getByText(label, { exact: true });
    await expect(button).toBeVisible();
    await button.click();
  }
}

/** The bottom bar's button by its words (商品详情 under a 拼团). */
function barButton(page: Page, label: string): Locator {
  return shown(page).locator('.shop-action-bar').getByText(label, { exact: true });
}

/** 商品详情 of a product under a 拼团 (`product { id }`). */
export class GroupbuyProductPage {
  constructor(readonly page: Page) {}

  async open(productId: number | string) {
    await openFresh(this.page, miniRoute('pages/product/index', { id: productId }));
    await expect(this.title()).toBeVisible();
  }

  title(): Locator {
    return shown(this.page).locator('#product-name');
  }

  /** The 拼团 box at the top: its price, team size and countdown. */
  promotion(): Locator {
    return shown(this.page).locator('.product__promotion');
  }

  button(label: '立即开团' | '单独购买' | '查看我的团'): Locator {
    return barButton(this.page, label);
  }

  /** 立即开团 → the SKU sheet → its 立即开团: on to 确认订单. */
  async startTeam() {
    await this.button('立即开团').click();
    const sheet = new ActivitySkuSheet(this.page);
    await sheet.expectShown();
    await sheet.confirm('立即开团');
  }
}

/** 拼团进度 (`groupbuyTeam { id }`). */
export class GroupbuyTeamPage {
  constructor(readonly page: Page) {}

  async open(groupId: number | string) {
    await openFresh(this.page, miniRoute('packages/promo/groupbuy-team/index', { id: groupId }));
    await expect(shown(this.page).locator('#groupbuy-team')).toBeVisible();
  }

  headline(): Locator {
    return shown(this.page).locator('#team-headline');
  }

  /** The seats row, named for what it holds: 「2 人团，已有 1 人」. */
  seats(): Locator {
    return shown(this.page).locator('.groupbuy-team__seats');
  }

  action(label: string): Locator {
    return shown(this.page).locator('#team-actions').getByText(label, { exact: true });
  }

  /** 参与拼团 → the SKU sheet → its 参与拼团: on to 确认订单. */
  async join() {
    const join = this.action('参与拼团');
    await expect(join).not.toHaveAttribute('aria-disabled', 'true');
    await join.click();
    const sheet = new ActivitySkuSheet(this.page);
    await sheet.expectShown();
    await sheet.confirm('参与拼团');
  }

  /**
   * Reopens the page until the headline reads `title`: a team settles on the worker (the
   * seats filling, the timer, the refund landing), not in the request that paid.
   */
  async waitForHeadline(title: string, timeout = 60_000) {
    await expect(async () => {
      await this.open(currentGroupId(this.page));
      await expect(this.headline()).toHaveText(title, { timeout: 3_000 });
    }).toPass({ timeout, intervals: [1_000, 2_000, 3_000] });
  }
}

/** The `id` of the 拼团进度 page shown now. */
export function currentGroupId(page: Page): string {
  const id = new URL(page.url().replace('/#/', '/')).searchParams.get('id');
  if (!id) throw new Error(`not on a team page: ${page.url()}`);
  return id;
}

/** 我的拼团 (`myGroupbuys`). */
export class MyGroupbuysPage {
  constructor(readonly page: Page) {}

  async open() {
    await openFresh(this.page, miniRoute('packages/promo/my-groupbuys/index'));
  }

  tab(name: '全部' | '拼团中' | '已成团' | '未成团'): Locator {
    return shown(this.page).locator('.shop-tabs').getByText(name, { exact: true });
  }

  /** The team cards of the tab shown, each a link named 「<title>，<status>」. */
  team(title: string): Locator {
    return shown(this.page).getByRole('link', { name: new RegExp(`^${title}，`) });
  }
}

/** 商品详情 of a product under a 预售 (`product { id }`). */
export class PresaleProductPage {
  constructor(readonly page: Page) {}

  async open(productId: number | string) {
    await openFresh(this.page, miniRoute('pages/product/index', { id: productId }));
    await expect(this.title()).toBeVisible();
  }

  title(): Locator {
    return shown(this.page).locator('#product-name');
  }

  /** The 预售 box at the top: its price, when it ships and the countdown. */
  promotion(): Locator {
    return shown(this.page).locator('.product__promotion');
  }

  /** 立即预订 ¥78.00 → the SKU sheet → its 立即预订: on to 确认订单. */
  async book() {
    await shown(this.page)
      .locator('.shop-action-bar')
      .getByText(/^立即预订/)
      .click();
    const sheet = new ActivitySkuSheet(this.page);
    await sheet.expectShown();
    await sheet.confirm('立即预订');
  }
}

/** 领券中心 (`couponCenter`). */
export class CouponCenterPage {
  constructor(readonly page: Page) {}

  async open() {
    await openFresh(this.page, miniRoute('packages/promo/coupons/index'));
    await expect(shown(this.page).locator('#coupon-center')).toBeVisible();
  }

  coupon(templateId: number | string): Locator {
    return shown(this.page).locator(`#coupon-${templateId}`);
  }

  async claim(templateId: number | string, name: string) {
    await this.coupon(templateId)
      .getByRole('button', { name: `立即领取 ${name}` })
      .click();
  }
}

/** 我的优惠券 (`myCoupons { state? }`). */
export class MyCouponsPage {
  constructor(readonly page: Page) {}

  async open(state: 'unused' | 'used' | 'expired' = 'unused') {
    await openFresh(this.page, miniRoute('packages/promo/my-coupons/index', { state }));
    await expect(shown(this.page).locator(`#my-coupons-${state}`)).toBeVisible();
  }

  list(state: 'unused' | 'used' | 'expired'): Locator {
    return shown(this.page).locator(`#my-coupons-${state}`);
  }
}
