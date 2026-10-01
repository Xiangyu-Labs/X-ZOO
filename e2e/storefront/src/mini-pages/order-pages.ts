import type { Locator, Page } from '@playwright/test';

import { expect } from '../fixtures';
import { miniRoute } from '../mini';
import { openFresh, shown } from './shown';

/**
 * Page objects for the mini-program's order pages (`apps/mini/src/packages/order`).
 * Locators are the words a shopper reads, plus the few element ids the pages set
 * for exactly this (`order-detail`, `review-submit`, …).
 */

/** Taro's H5 hash route → the query of the page shown now. */
export function currentQuery(page: Page): URLSearchParams {
  return new URL(page.url().replace('/#/', '/')).searchParams;
}

/** A button or link on the page by its visible words. */
function tap(page: Page, words: string): Locator {
  return shown(page).getByText(words, { exact: true });
}

/**
 * The answer button of the dialog now open (`showModal`). The dialog is the last thing on the
 * page, and its confirm button may say what the bar button says (取消订单).
 */
export function dialogButton(page: Page, label: string): Locator {
  return shown(page).getByText(label, { exact: true }).last();
}

/** 我的订单. */
export class OrderListPage {
  constructor(readonly page: Page) {}

  async open(tab?: 'unpaid' | 'unshipped' | 'unreceived' | 'finished' | 'cancelled') {
    await openFresh(this.page, miniRoute('packages/order/list/index', tab ? { tab } : {}));
  }

  tab(name: '全部' | '待付款' | '待发货' | '待收货' | '已完成' | '已取消'): Locator {
    return shown(this.page).locator('.shop-tabs').getByText(name, { exact: true });
  }

  /** The card showing `orderNo`. */
  card(orderNo: string): Locator {
    return shown(this.page).locator('.shop-order').filter({ hasText: orderNo });
  }
}

/** 订单详情. */
export class OrderDetailPage {
  constructor(readonly page: Page) {}

  async open(orderId: string) {
    await openFresh(this.page, miniRoute('packages/order/detail/index', { id: orderId }));
    await expect(shown(this.page).locator('#order-detail')).toBeVisible();
  }

  async expectHeadline(title: string) {
    await expect(shown(this.page).locator('.order-detail__status')).toHaveText(title);
  }

  /** A button in the bottom bar (取消订单, 确认收货, 去评价 …). */
  action(label: string): Locator {
    return shown(this.page).locator('.shop-action-bar').getByText(label, { exact: true });
  }

  /** The parcel card (物流信息), a link to 物流. */
  parcel(): Locator {
    return shown(this.page).getByRole('link', { name: '查看物流' }).first();
  }

  /** 申请售后 next to the lines. */
  aftersale(): Locator {
    return shown(this.page).getByRole('link', { name: '申请售后' });
  }
}

/** 物流. */
export class LogisticsPage {
  constructor(readonly page: Page) {}

  async expectParcel(company: string, trackingNo: string) {
    await expect(this.page).toHaveURL(/packages\/order\/logistics\/index\?/);
    await expect(shown(this.page).getByText(company, { exact: false }).first()).toBeVisible();
    await expect(shown(this.page).getByText(trackingNo, { exact: false }).first()).toBeVisible();
  }
}

/** 评价. */
export class ReviewPage {
  constructor(readonly page: Page) {}

  async expectOpen() {
    await expect(this.page).toHaveURL(/packages\/order\/review\/index\?/);
    await expect(shown(this.page).locator('#review-submit')).toBeVisible();
  }

  /** The words for the first line still to review. */
  async write(words: string) {
    await shown(this.page).locator('.review__card textarea').first().fill(words);
  }

  async submit() {
    await tap(this.page, '提交评价').click();
  }

  result(): Locator {
    return shown(this.page).locator('#review-result');
  }
}
