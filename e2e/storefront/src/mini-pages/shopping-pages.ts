import type { Locator, Page } from '@playwright/test';

import { expect } from '../fixtures';
import { miniRoute } from '../mini';
import { DECOR_HOME } from '../seed';
import { openFresh, shown } from './shown';

/**
 * Page objects for the mini-program's shopping pages (stream B): 首页, 分类, 搜索, 商品列表,
 * 商品详情 with its 规格 sheet, 购物车, 确认订单, 收银台 and 支付结果. Locators are the words a
 * shopper reads and the accessible names the pages give (`选择 E2E 多规格商品`, `增加…的数量`),
 * plus the few element ids the pages set for exactly this (`#cart-bar`, `#checkout-bar`, …).
 * Everything goes through `shown()`: Taro's H5 router keeps the pages below in the DOM.
 */

/** Words the shopper taps, exactly. */
function tap(page: Page, words: string): Locator {
  return shown(page).getByText(words, { exact: true });
}

/** The tab bar (Taro H5 draws it as links). */
export async function openTab(page: Page, tab: '首页' | '分类' | '购物车' | '我的'): Promise<void> {
  await page.locator('.taro-tabbar__tabbar').getByText(tab, { exact: true }).click();
}

/** 首页: the seeded 页面装修 v2 document (`src/seed.ts` `DECOR_HOME`). */
export class HomePage {
  constructor(readonly page: Page) {}

  async open() {
    await openFresh(this.page, miniRoute('pages/index/index'));
    await expect(tap(this.page, DECOR_HOME.gridTitle)).toBeVisible();
  }

  /** The page's 搜索框 block. */
  async openSearch() {
    await tap(this.page, DECOR_HOME.search).click();
  }

  /** The 导航宫格 entry into the seeded category. */
  async openCategoryEntry() {
    await tap(this.page, DECOR_HOME.categoryEntry).click();
  }

  /** A product card in the 商品 block. */
  async openProduct(name: string) {
    await tap(this.page, name).click();
  }
}

/** 分类 (tab). */
export class CategoryPage {
  constructor(readonly page: Page) {}

  tab(name: string): Locator {
    return shown(this.page).getByRole('tab', { name });
  }

  product(name: string): Locator {
    return shown(this.page).getByRole('link', { name });
  }
}

/** 搜索 and 商品列表. */
export class SearchPage {
  constructor(readonly page: Page) {}

  async search(keyword: string) {
    const field = shown(this.page).locator('.shop-search input');
    await field.fill(keyword);
    await field.press('Enter');
  }

  /** A result on 商品列表, by product name. */
  result(name: string | RegExp): Locator {
    return shown(this.page).getByRole('link', { name });
  }
}

/** 商品详情 and its 规格 sheet. */
export class ProductPage {
  constructor(readonly page: Page) {}

  async open(productId: number | string) {
    await openFresh(this.page, miniRoute('pages/product/index', { id: productId }));
    await expect(shown(this.page).locator('#product-name')).toBeVisible();
  }

  name(): Locator {
    return shown(this.page).locator('#product-name');
  }

  /** The price at the top of the page (the low end of a multi-spec product's range). */
  summaryPrice(): Locator {
    return shown(this.page).locator('.product__price-row .shop-price').first();
  }

  /** The bar's 加入购物车 / 立即购买. */
  barButton(label: '加入购物车' | '立即购买'): Locator {
    return shown(this.page).locator('.shop-action-bar').getByText(label, { exact: true });
  }

  /** 已选: opens the sheet with both buttons. */
  async openSpecs() {
    await shown(this.page)
      .getByRole('link', { name: /^选择规格/ })
      .click();
    await expect(this.sheet()).toBeVisible();
  }

  sheet(): Locator {
    return shown(this.page).locator('#sku-sheet');
  }

  /** A spec value in the sheet (白, 黑, M, L). */
  specValue(value: string): Locator {
    return this.sheet().getByRole('radio', { name: value, exact: true });
  }

  /** The sheet's own 加入购物车 / 立即购买 / 确定, in its footer. */
  sheetButton(label: '加入购物车' | '立即购买' | '确定'): Locator {
    return shown(this.page).locator('.shop-sheet--shown').getByText(label, { exact: true }).last();
  }

  /** The sheet header's price, e.g. `¥65.00`. */
  sheetPrice(): Locator {
    return this.sheet().locator('.sku-sheet__header .shop-price').first();
  }

  cartIcon(): Locator {
    return shown(this.page)
      .locator('.shop-action-bar')
      .getByRole('button', { name: /^购物车/ });
  }
}

/** 购物车 (tab). */
export class CartPage {
  constructor(readonly page: Page) {}

  async open() {
    await openFresh(this.page, miniRoute('pages/cart/index'));
  }

  row(name: string): Locator {
    return shown(this.page).locator('.cart-row').filter({ hasText: name });
  }

  increase(name: string): Locator {
    return shown(this.page).getByRole('button', { name: `增加${name}的数量` });
  }

  quantity(name: string): Locator {
    return shown(this.page).locator(`[aria-label="${name}的数量"]`);
  }

  bar(): Locator {
    return shown(this.page).locator('#cart-bar');
  }

  async checkout() {
    await this.bar().getByText(/^结算/).click();
  }
}

/** 确认订单. */
export class CheckoutPage {
  constructor(readonly page: Page) {}

  async expectShown() {
    await expect(this.page).toHaveURL(/packages\/order\/checkout\/index/);
    await expect(this.bar()).toBeVisible();
  }

  bar(): Locator {
    return shown(this.page).locator('#checkout-bar');
  }

  /** The 优惠券 cell; its accessible name carries what it shows (`优惠券，-¥5.00`). */
  couponCell(): Locator {
    return shown(this.page).getByRole('link', { name: /^优惠券，/ });
  }

  couponSheet(): Locator {
    return shown(this.page).locator('#coupon-sheet');
  }

  async importWechatAddress() {
    await shown(this.page).getByRole('button', { name: '导入微信地址' }).first().click();
  }

  address(): Locator {
    return shown(this.page).locator('.shop-address');
  }

  async submit() {
    const submit = shown(this.page).locator('#checkout-submit');
    await expect(submit).not.toHaveAttribute('aria-disabled', 'true');
    await submit.click();
  }
}

/** 收银台 → 支付结果. */
export class CashierPage {
  constructor(readonly page: Page) {}

  async expectShown() {
    await expect(this.page).toHaveURL(/packages\/order\/cashier\/index\?orderId=\d+/);
  }

  amount(): Locator {
    return shown(this.page).locator('#cashier-amount');
  }

  async pay() {
    await tap(this.page, '微信支付').last().click();
  }
}

export class PayResultPage {
  constructor(readonly page: Page) {}

  async expectPaid() {
    await expect(this.page).toHaveURL(
      /packages\/order\/pay-result\/index\?orderId=\d+&outTradeNo=/,
    );
    await expect(shown(this.page).locator('#pay-result')).toContainText('支付成功');
  }
}
