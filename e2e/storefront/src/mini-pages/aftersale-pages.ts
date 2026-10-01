import type { Locator, Page } from '@playwright/test';

import { expect } from '../fixtures';
import { miniRoute } from '../mini';
import { openFresh, shown } from './shown';

/** Page objects for the mini-program's after-sales pages (`apps/mini/src/packages/aftersale`). */

/** 申请售后. */
export class RefundApplyPage {
  constructor(readonly page: Page) {}

  async expectOpen() {
    await expect(this.page).toHaveURL(/packages\/aftersale\/apply\/index\?orderId=\d+/);
    await expect(shown(this.page).locator('#refund-apply')).toBeVisible();
  }

  kind(label: '仅退款' | '退货退款'): Locator {
    return shown(this.page).locator('.refund-apply__kinds').getByText(label, { exact: true });
  }

  /** Opens 售后原因 and picks one. */
  async chooseReason(reason: string) {
    await shown(this.page).getByRole('link', { name: '选择售后原因' }).click();
    await shown(this.page)
      .locator('.refund-apply__reasons')
      .getByText(reason, { exact: true })
      .click();
  }

  async explain(words: string) {
    await shown(this.page).locator('#refund-apply textarea').fill(words);
  }

  async submit() {
    await shown(this.page).locator('#refund-apply-submit').click();
  }
}

/** 售后详情. */
export class RefundDetailPage {
  constructor(readonly page: Page) {}

  async open(refundId: string) {
    await openFresh(this.page, miniRoute('packages/aftersale/detail/index', { id: refundId }));
    await expect(shown(this.page).locator('#refund-detail')).toBeVisible();
  }

  async expectStatus(text: string) {
    await expect(shown(this.page).locator('.refund-detail__status')).toHaveText(text);
  }

  action(label: string): Locator {
    return shown(this.page).locator('.shop-action-bar').getByText(label, { exact: true });
  }

  /** The 售后进度 timeline's entries, newest first. */
  steps(): Locator {
    return shown(this.page).locator('.shop-timeline__item');
  }
}

/** 我的售后. */
export class RefundListPage {
  constructor(readonly page: Page) {}

  async open() {
    await openFresh(this.page, miniRoute('packages/aftersale/list/index'));
  }

  tab(name: '全部' | '处理中' | '已退款' | '已关闭'): Locator {
    return shown(this.page).locator('.shop-tabs').getByText(name, { exact: true });
  }

  card(refundNo: string): Locator {
    return shown(this.page).locator('.refund-card').filter({ hasText: refundNo });
  }
}

/** 填写退货物流. */
export class ReturnShipmentPage {
  constructor(readonly page: Page) {}

  async expectOpen() {
    await expect(this.page).toHaveURL(/packages\/aftersale\/return-shipment\/index\?id=\d+/);
    await expect(shown(this.page).locator('#return-shipment')).toBeVisible();
  }

  /** Opens the courier sheet, searches and picks `name`. */
  async chooseCompany(search: string, name: string) {
    await shown(this.page).getByRole('link', { name: '选择快递公司' }).click();
    await shown(this.page).locator('input[placeholder="输入名称搜索"]').fill(search);
    await shown(this.page)
      .locator('.return-shipment__companies')
      .getByText(name, { exact: true })
      .click();
  }

  async fill(trackingNo: string, phone?: string) {
    await shown(this.page).locator('input[placeholder="请填写快递单号"]').fill(trackingNo);
    if (phone !== undefined)
      await shown(this.page).locator('input[placeholder="选填，便于商家联系"]').fill(phone);
  }

  async submit() {
    await shown(this.page).locator('#return-shipment-submit').click();
  }
}
